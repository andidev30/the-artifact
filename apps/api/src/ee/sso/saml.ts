import { createHash, randomBytes } from 'node:crypto'
import { type CacheProvider, generateServiceProviderMetadata, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import { DOMParser } from '@xmldom/xmldom'
import { and, eq, gt, lt } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthEnv } from '../../auth/session.js'
import { continueSignIn } from '../../auth/twofactor.js'
import { afterSignInUrl, SignupClosedError, signInErrorUrl } from '../../auth/users.js'
import { db, schema } from '../../db/index.js'
import type { SsoConnection } from '../../db/schema.js'
import { env } from '../../env.js'
import { hasEnterprise } from '../../license.js'
import { clientIp, defineLimit, hit } from '../../limits.js'
import { log } from '../../log.js'
import { EMAIL_RE } from '../../validation.js'
import { coversDomain, describeConnection, parseShared, type SharedInput, usableConnection } from './connections.js'
import { accountFor } from './routes.js'
import { fetchIdpMetadata, parseIdpMetadata, pem } from './saml-metadata.js'

// SAML 2.0 single sign-on, for connections with protocol 'saml'. SP-initiated: "Continue with …"
// (GET /api/auth/sso/<id>, routes.ts) sends people to the IdP with an AuthnRequest (HTTP-Redirect),
// and the IdP posts a signed Response back to this server's one ACS URL.
//
// Everything about the response is decided by @node-saml/node-saml: the signature (the assertion must
// be signed by a certificate from the IdP's metadata), the audience, NotBefore/NotOnOrAfter and
// InResponseTo. Only the profile it returns is read, which it builds from the XML the signature
// covers, never from the raw document, so wrapped or unsigned elements can't slip in. On top of it:
// the issuer and the Recipient must match, the response must come back to the browser that started
// the sign-in, and an assertion signs someone in once.

export type SamlConfig = {
  metadataUrl: string | null
  metadataXml: string | null
  idpEntityId: string
  // HTTP-Redirect binding of the IdP's SingleSignOnService
  ssoUrl: string
  // Signing certificates, base64 DER without PEM headers
  certificates: string[]
  // Attribute names for the email address and the name; null reads the usual ones
  emailAttribute: string | null
  nameAttribute: string | null
  // Responses the IdP sends without a request from this server; off unless the admin turns it on
  allowIdpInitiated: boolean
}

export function samlConfig(conn: SsoConnection): SamlConfig {
  const c = conn.config as Partial<SamlConfig>
  return {
    metadataUrl: typeof c.metadataUrl === 'string' ? c.metadataUrl : null,
    metadataXml: typeof c.metadataXml === 'string' ? c.metadataXml : null,
    idpEntityId: String(c.idpEntityId ?? ''),
    ssoUrl: String(c.ssoUrl ?? ''),
    certificates: Array.isArray(c.certificates) ? c.certificates.filter((x): x is string => typeof x === 'string') : [],
    emailAttribute: typeof c.emailAttribute === 'string' ? c.emailAttribute : null,
    nameAttribute: typeof c.nameAttribute === 'string' ? c.nameAttribute : null,
    allowIdpInitiated: c.allowIdpInitiated === true,
  }
}

const REQUEST_TTL = 10 * 60 * 1000
const CLOCK_SKEW = 60 * 1000
// Assertions older than this (from their IssueInstant) are refused, whatever NotOnOrAfter says; used
// assertion IDs are kept this long, so a replay is either remembered or too old
const MAX_ASSERTION_AGE = 10 * 60 * 1000
const REQUEST_COOKIE = 'saml_request'
const FLOW_PATH = '/api/auth/sso/saml'
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'

// Answers from IdPs arriving from one address
defineLimit('saml-ip', { max: 100, seconds: 15 * 60 })

// One service provider for the whole install, so the admin can register it at the IdP before the
// connection exists; each response is matched to its connection by the request it answers
export const spEntityId = () => `${env.appUrl}/api/auth/sso/saml/metadata`
export const acsUrl = () => `${env.appUrl}/api/auth/sso/saml/acs`

// Request IDs live in Postgres, not memory, so any server process can take the response. They are
// kept per connection: a response only counts for the connection that sent the request.
function requestCache(connectionId: string): CacheProvider {
  return {
    async saveAsync(key, value) {
      await db.delete(schema.samlRequests).where(lt(schema.samlRequests.expiresAt, new Date()))
      await db
        .insert(schema.samlRequests)
        .values({ id: key, connectionId, issuedAt: value, expiresAt: new Date(Date.now() + REQUEST_TTL) })
        .onConflictDoNothing()
      return { value, createdAt: Date.now() }
    },
    async getAsync(key) {
      const [row] = await db
        .select({ issuedAt: schema.samlRequests.issuedAt })
        .from(schema.samlRequests)
        .where(and(eq(schema.samlRequests.id, key), eq(schema.samlRequests.connectionId, connectionId), gt(schema.samlRequests.expiresAt, new Date())))
      return row?.issuedAt ?? null
    },
    async removeAsync(key) {
      if (!key) return null
      const [row] = await db.delete(schema.samlRequests).where(eq(schema.samlRequests.id, key)).returning({ issuedAt: schema.samlRequests.issuedAt })
      return row?.issuedAt ?? null
    },
  }
}

function samlFor(conn: SsoConnection, requestId?: string): SAML {
  const config = samlConfig(conn)
  return new SAML({
    issuer: spEntityId(),
    callbackUrl: acsUrl(),
    audience: spEntityId(),
    entryPoint: config.ssoUrl,
    idpCert: config.certificates.map(pem),
    // The assertion itself must be signed; a signed Response around an unsigned assertion isn't enough
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: CLOCK_SKEW,
    maxAssertionAgeMs: MAX_ASSERTION_AGE,
    validateInResponseTo: config.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: REQUEST_TTL,
    cacheProvider: requestCache(conn.id),
    // Let the IdP choose the NameID format and how people authenticate (Entra ID refuses requests
    // asking for a password when someone signed in another way)
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  })
}

type Attributes = Record<string, unknown>

function firstString(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'Email',
  'emailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
]
const NAME_ATTRIBUTES = ['displayName', 'name', 'http://schemas.microsoft.com/identity/claims/displayname', 'urn:oid:2.16.840.1.113730.3.1.241']
const GIVEN = ['firstName', 'givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42']
const FAMILY = ['lastName', 'surname', 'sn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4']

function pick(attrs: Attributes, names: string[]): string | null {
  for (const n of names) {
    const v = firstString(attrs[n])
    if (v) return v
  }
  return null
}

// Email and name from the validated profile: the attributes the admin named, else the usual ones,
// else a NameID that is an email address
export function mapProfile(profile: Profile, config: Pick<SamlConfig, 'emailAttribute' | 'nameAttribute'>) {
  const attrs = (profile.attributes ?? {}) as Attributes
  const email = (
    config.emailAttribute
      ? firstString(attrs[config.emailAttribute])
      : (pick(attrs, EMAIL_ATTRIBUTES) ?? (profile.nameIDFormat === EMAIL_FORMAT || EMAIL_RE.test(profile.nameID ?? '') ? profile.nameID : null))
  )?.toLowerCase()
  const given = pick(attrs, GIVEN)
  const family = pick(attrs, FAMILY)
  const name = config.nameAttribute
    ? firstString(attrs[config.nameAttribute])
    : (pick(attrs, NAME_ATTRIBUTES) ?? ([given, family].filter(Boolean).join(' ') || null))
  return { email: email && EMAIL_RE.test(email) && email.length <= 254 ? email : null, name: name ? name.slice(0, 200) : null }
}

type XmlJs = { $?: Record<string, string> } & Record<string, unknown>

// The Recipient of the bearer SubjectConfirmationData must be this server's ACS URL; node-saml
// doesn't check it. Read from the validated assertion.
function recipientMatches(profile: Profile): boolean {
  const assertion = (profile.getAssertion?.() as { Assertion?: XmlJs } | undefined)?.Assertion
  const subject = (assertion?.Subject as XmlJs[] | undefined)?.[0]
  const confirmations = (subject?.SubjectConfirmation as XmlJs[] | undefined) ?? []
  return confirmations.some((sc) => ((sc.SubjectConfirmationData as XmlJs[] | undefined) ?? []).some((d) => d.$?.Recipient === acsUrl()))
}

function assertionId(profile: Profile): string | null {
  const assertion = (profile.getAssertion?.() as { Assertion?: XmlJs } | undefined)?.Assertion
  return assertion?.$?.ID ?? null
}

// Records the assertion as used. False when it was used before.
async function firstUse(connectionId: string, id: string): Promise<boolean> {
  await db.delete(schema.samlAssertions).where(lt(schema.samlAssertions.expiresAt, new Date()))
  const key = createHash('sha256').update(`${connectionId}:${id}`).digest('hex')
  const rows = await db
    .insert(schema.samlAssertions)
    .values({ id: key, expiresAt: new Date(Date.now() + MAX_ASSERTION_AGE + 2 * CLOCK_SKEW) })
    .onConflictDoNothing()
    .returning({ id: schema.samlAssertions.id })
  return rows.length > 0
}

// The IdP posts across sites, so the cookie that ties the response to this browser has to be
// SameSite=None, which browsers only keep when Secure (localhost counts as secure)
function flowCookie(c: Context, value: string) {
  setCookie(c, REQUEST_COOKIE, value, { path: FLOW_PATH, httpOnly: true, secure: true, sameSite: 'None', maxAge: REQUEST_TTL / 1000 })
}

// Called by GET /api/auth/sso/<id> (routes.ts) for a SAML connection
export async function startSaml(c: Context, conn: SsoConnection, next: string | null): Promise<Response> {
  const requestId = `_${randomBytes(20).toString('hex')}`
  try {
    const url = await samlFor(conn, requestId).getAuthorizeUrlAsync(next ?? '', undefined, {})
    flowCookie(c, requestId)
    return c.redirect(url)
  } catch (err) {
    log.error('SAML sign-in could not start', { err, connectionId: conn.id })
    return c.redirect(signInErrorUrl('sso_failed'))
  }
}

// The Issuer of a response nobody asked for, only to pick the connection that then checks it in full
function unverifiedIssuer(response: string): string | null {
  try {
    const doc = new DOMParser({ errorHandler: {} }).parseFromString(Buffer.from(response, 'base64').toString('utf8'), 'text/xml')
    const root = doc?.documentElement
    for (let n = root?.firstChild ?? null; n; n = n.nextSibling) {
      if (n.nodeType === 1 && (n as unknown as Element).localName === 'Issuer') return n.textContent?.trim() || null
    }
  } catch {
    return null
  }
  return null
}

// The connection a response is for: the one whose request this browser started, else (for a
// response the IdP sent on its own) a connection that allows that and names the same IdP
async function connectionFor(requestId: string | undefined, response: string): Promise<SsoConnection | null> {
  if (requestId) {
    const [row] = await db
      .select({ connectionId: schema.samlRequests.connectionId })
      .from(schema.samlRequests)
      .where(and(eq(schema.samlRequests.id, requestId), gt(schema.samlRequests.expiresAt, new Date())))
    if (row) {
      const conn = await usableConnection(row.connectionId)
      return conn?.protocol === 'saml' ? conn : null
    }
  }
  const issuer = unverifiedIssuer(response)
  if (!issuer || !(await hasEnterprise())) return null
  const rows = await db
    .select()
    .from(schema.ssoConnections)
    .where(and(eq(schema.ssoConnections.protocol, 'saml'), eq(schema.ssoConnections.enabled, true)))
  return rows.find((r) => samlConfig(r).allowIdpInitiated && samlConfig(r).idpEntityId === issuer) ?? null
}

// Mounted at /api/auth/sso/saml, next to the OIDC routes
export const samlSignIn = new Hono<AuthEnv>()

samlSignIn.use(async (c, next) => {
  if (!env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  await next()
})

samlSignIn.get('/metadata', async (c) => {
  if (!(await hasEnterprise())) return c.json({ error: 'Not found.' }, 404)
  const xml = generateServiceProviderMetadata({ issuer: spEntityId(), callbackUrl: acsUrl(), identifierFormat: EMAIL_FORMAT, wantAssertionsSigned: true })
  return c.body(xml, 200, { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8' })
})

samlSignIn.post('/acs', async (c) => {
  const expected = getCookie(c, REQUEST_COOKIE)
  deleteCookie(c, REQUEST_COOKIE, { path: FLOW_PATH, secure: true, sameSite: 'None' })
  const ip = clientIp(c)
  if (ip && (await hit('saml-ip', ip)) !== null) return c.redirect(signInErrorUrl('sso_failed'))

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
  const response = typeof form.SAMLResponse === 'string' ? form.SAMLResponse : ''
  const relayState = typeof form.RelayState === 'string' ? form.RelayState : ''
  if (!response) return c.redirect(signInErrorUrl('sso_failed'))
  const conn = await connectionFor(expected, response)
  if (!conn) return c.redirect(signInErrorUrl('sso_unavailable'))
  const config = samlConfig(conn)

  let profile: Profile | null
  try {
    profile = (await samlFor(conn).validatePostResponseAsync({ SAMLResponse: response })).profile
  } catch (err) {
    log.warn('SAML response refused', { connectionId: conn.id, reason: err instanceof Error ? err.message : String(err) })
    return c.redirect(signInErrorUrl('sso_failed'))
  }
  const refuse = (reason: string, code = 'sso_failed') => {
    log.warn('SAML response refused', { connectionId: conn.id, reason })
    return c.redirect(signInErrorUrl(code))
  }
  if (!profile) return refuse('no profile')
  if (profile.issuer !== config.idpEntityId) return refuse('issuer does not match the IdP metadata')
  if (!recipientMatches(profile)) return refuse('Recipient is not this server’s ACS URL')
  // node-saml has checked InResponseTo against the requests this connection sent; it must also be the
  // request this browser started, or someone could sign a victim in to the attacker's account
  const inResponseTo = typeof profile.inResponseTo === 'string' ? profile.inResponseTo : null
  if (inResponseTo ? inResponseTo !== expected : !config.allowIdpInitiated) return refuse('response is not for this browser’s sign-in')
  const id = assertionId(profile)
  if (!id) return refuse('assertion has no ID')
  if (!(await firstUse(conn.id, id))) return refuse('assertion was already used')

  const { email, name } = mapProfile(profile, config)
  if (!email) return refuse('no email address in the assertion', 'sso_no_email')
  if (!coversDomain(conn, email)) return refuse('address is not at one of the connection’s domains', 'sso_domain')
  // A transient NameID changes at every sign-in, so the address stands in for it
  const subject = profile.nameID && profile.nameIDFormat !== TRANSIENT ? profile.nameID : `email:${email}`

  try {
    // The IdP vouches for its addresses: the admin set it up, and its domains limit which ones count
    const user = await accountFor(conn, { subject, email, emailVerified: true, name })
    log.info('Signed in with SSO', { userId: user.id, connectionId: conn.id })
    // RelayState comes back from the IdP unsigned; only same-site paths are followed
    return c.redirect(await continueSignIn(c, user, afterSignInUrl(null, relayState), 'sso'))
  } catch (err) {
    if (err instanceof SignupClosedError) return c.redirect(signInErrorUrl(err.code))
    throw err
  }
})

// The admin settings of a SAML connection, as /api/admin/sso shows them
export function describeSaml(conn: SsoConnection) {
  const config = samlConfig(conn)
  return describeConnection(conn, {
    metadataUrl: config.metadataUrl,
    idpEntityId: config.idpEntityId,
    ssoUrl: config.ssoUrl,
    certificates: config.certificates.length,
    emailAttribute: config.emailAttribute,
    nameAttribute: config.nameAttribute,
    allowIdpInitiated: config.allowIdpInitiated,
  })
}

const optionalName = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null)

type SamlParsed = { ok: true; shared: SharedInput; config: SamlConfig } | { ok: false; error: string; field: string }

// What the admin form sends for a SAML connection: the shared settings, and the IdP from its metadata
// URL (downloaded again on every save) or pasted XML. Editing without new metadata keeps the IdP.
export async function parseSamlConnection(body: unknown, existing: SsoConnection | null): Promise<SamlParsed> {
  const b = (body ?? {}) as Record<string, unknown>
  const shared = parseShared(b)
  if (!shared.ok) return shared
  const old = existing ? samlConfig(existing) : null

  const metadataUrl = typeof b.metadataUrl === 'string' ? b.metadataUrl.trim() : ''
  let metadataXml = typeof b.metadataXml === 'string' ? b.metadataXml.trim() : ''
  if (metadataUrl) {
    const fetched = await fetchIdpMetadata(metadataUrl)
    if (!fetched.ok) return { ok: false, error: fetched.error, field: 'metadataUrl' }
    metadataXml = fetched.xml
  }
  let idp: { entityId: string; ssoUrl: string; certificates: string[] }
  if (metadataXml) {
    const parsed = parseIdpMetadata(metadataXml)
    if (!parsed.ok) return { ok: false, error: parsed.error, field: metadataUrl ? 'metadataUrl' : 'metadataXml' }
    idp = parsed.value
  } else if (old) {
    idp = { entityId: old.idpEntityId, ssoUrl: old.ssoUrl, certificates: old.certificates }
  } else {
    return { ok: false, error: 'Enter your IdP’s metadata URL, or paste its metadata XML.', field: 'metadataUrl' }
  }
  return {
    ok: true,
    shared: shared.value,
    config: {
      metadataUrl: metadataUrl || (metadataXml ? null : (old?.metadataUrl ?? null)),
      metadataXml: metadataUrl ? null : metadataXml || (old?.metadataXml ?? null),
      idpEntityId: idp.entityId,
      ssoUrl: idp.ssoUrl,
      certificates: idp.certificates,
      emailAttribute: optionalName(b.emailAttribute),
      nameAttribute: optionalName(b.nameAttribute),
      allowIdpInitiated: b.allowIdpInitiated === true,
    },
  }
}
