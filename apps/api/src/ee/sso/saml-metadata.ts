import { X509Certificate } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'

// Reads what signing in needs from an IdP's SAML metadata: its entity id, where to send people
// (the HTTP-Redirect SingleSignOnService) and the certificates it signs with. The admin supplies the
// metadata, and nothing here trusts it further than that: assertions are still checked against these
// certificates by node-saml on every sign-in.

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata'
const DS = 'http://www.w3.org/2000/09/xmldsig#'
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
export const MAX_METADATA_BYTES = 1024 * 1024

export type IdpMetadata = { entityId: string; ssoUrl: string; certificates: string[] }

type Result = { ok: true; value: IdpMetadata } | { ok: false; error: string }

const NOT_METADATA = 'This is not SAML metadata from an identity provider. Copy the whole XML file, starting with <EntityDescriptor.'

function children(parent: Element, ns: string, name: string): Element[] {
  const out: Element[] = []
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === name) out.push(n as Element)
  }
  return out
}

export function parseIdpMetadata(xml: string): Result {
  const text = xml.trim()
  if (!text) return { ok: false, error: NOT_METADATA }
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) return { ok: false, error: 'This metadata is larger than 1 MB. Check that it is the right file.' }
  // Metadata never needs a DTD; refusing one rules out entity tricks before parsing
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, error: NOT_METADATA }

  let doc: Document
  const problems: string[] = []
  try {
    doc = new DOMParser({ errorHandler: { error: (m: string) => problems.push(m), fatalError: (m: string) => problems.push(m) } }).parseFromString(
      text,
      'text/xml',
    ) as unknown as Document
  } catch {
    return { ok: false, error: NOT_METADATA }
  }
  const root = doc?.documentElement
  if (problems.length || !root || root.namespaceURI !== MD) return { ok: false, error: NOT_METADATA }

  // A single EntityDescriptor, or the first one with an IdP role inside an EntitiesDescriptor
  const entities = root.localName === 'EntityDescriptor' ? [root] : root.localName === 'EntitiesDescriptor' ? children(root, MD, 'EntityDescriptor') : []
  const entity = entities.find((e) => children(e, MD, 'IDPSSODescriptor').length > 0)
  if (!entity) return { ok: false, error: 'This metadata has no identity provider in it. Use the metadata of your IdP’s app, not of this server.' }

  const entityId = entity.getAttribute('entityID')?.trim() ?? ''
  if (!entityId) return { ok: false, error: NOT_METADATA }
  const idp = children(entity, MD, 'IDPSSODescriptor')[0]

  const sso = children(idp, MD, 'SingleSignOnService').find((s) => s.getAttribute('Binding') === REDIRECT)
  const ssoUrl = sso?.getAttribute('Location')?.trim() ?? ''
  let url: URL | null = null
  try {
    url = new URL(ssoUrl)
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return { ok: false, error: 'This metadata has no sign-in address for the HTTP-Redirect binding, which this server uses.' }
  }

  const certificates: string[] = []
  for (const key of children(idp, MD, 'KeyDescriptor')) {
    const use = key.getAttribute('use')
    if (use && use !== 'signing') continue
    for (const info of children(key, DS, 'KeyInfo')) {
      for (const data of children(info, DS, 'X509Data')) {
        for (const cert of children(data, DS, 'X509Certificate')) {
          const body = (cert.textContent ?? '').replace(/\s+/g, '')
          if (!body || certificates.includes(body)) continue
          try {
            new X509Certificate(Buffer.from(body, 'base64'))
          } catch {
            return { ok: false, error: 'A signing certificate in this metadata can’t be read. Download the metadata again.' }
          }
          certificates.push(body)
        }
      }
    }
  }
  if (!certificates.length) return { ok: false, error: 'This metadata has no signing certificate, so sign-ins from it can’t be checked.' }
  return { ok: true, value: { entityId, ssoUrl: url.toString(), certificates } }
}

// Metadata from the IdP's metadata URL, fetched when the admin saves the connection
export async function fetchIdpMetadata(address: string): Promise<{ ok: true; xml: string } | { ok: false; error: string }> {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return { ok: false, error: 'Enter the metadata URL, starting with https://.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Enter the metadata URL, starting with https://.' }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' } })
    if (!res.ok) return { ok: false, error: `The metadata URL answered with ${res.status}. Check the address, or paste the XML instead.` }
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_METADATA_BYTES) return { ok: false, error: 'This metadata is larger than 1 MB. Check that it is the right file.' }
    const xml = await res.text()
    if (Buffer.byteLength(xml) > MAX_METADATA_BYTES) return { ok: false, error: 'This metadata is larger than 1 MB. Check that it is the right file.' }
    return { ok: true, xml }
  } catch {
    return { ok: false, error: 'This server couldn’t download the metadata. Check the address, or paste the XML instead.' }
  }
}

export function pem(body: string): string {
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? body}\n-----END CERTIFICATE-----\n`
}
