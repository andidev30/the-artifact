import { createSign, generateKeyPairSync, randomUUID, X509Certificate, type KeyObject } from 'node:crypto'
import { SignedXml } from 'xml-crypto'

// A SAML identity provider for tests: an RSA key with a self-signed certificate (built here in DER,
// since Node can't issue certificates), its metadata, and signed Responses shaped like Okta's.

function der(tag: number, content: Buffer): Buffer {
  const n = content.length
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, content])
}
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts))
const oid = (hex: string) => Buffer.from(hex, 'hex')
const SHA256_RSA = oid('06092a864886f70d01010b')
const CN = oid('0603550403')

function utcTime(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(2, 14)
  return der(0x17, Buffer.from(`${s}Z`))
}

function selfSigned(privateKey: KeyObject, publicKey: KeyObject, commonName: string): string {
  const name = seq(der(0x31, seq(CN, der(0x0c, Buffer.from(commonName)))))
  const algorithm = seq(SHA256_RSA, Buffer.from([0x05, 0x00]))
  const now = Date.now()
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, Buffer.from([0x01, ...Buffer.from(randomUUID().replace(/-/g, '').slice(0, 14), 'hex')])),
    algorithm,
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 3_650 * 86_400_000))),
    name,
    publicKey.export({ format: 'der', type: 'spki' }),
  )
  const signature = createSign('sha256').update(tbs).sign(privateKey)
  const cert = seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0x00]), signature])))
  new X509Certificate(cert)
  return cert.toString('base64')
}

export type TestIdp = {
  entityId: string
  ssoUrl: string
  certificate: string
  privateKeyPem: string
  metadata: string
}

export function createIdp(entityId = 'http://www.okta.com/exk-test'): TestIdp {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const certificate = selfSigned(privateKey, publicKey, 'Test IdP')
  const ssoUrl = 'https://idp.example.com/app/sso/saml'
  const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificate.match(/.{1,64}/g)?.join('\n')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ssoUrl}"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`
  return { entityId, ssoUrl, certificate, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), metadata }
}

export type AssertionOptions = {
  inResponseTo?: string | null
  audience?: string
  recipient?: string
  issuer?: string
  nameId?: string
  email?: string
  name?: string
  assertionId?: string
  issuedAt?: Date
  notOnOrAfter?: Date
  // Signs with this key instead of the IdP's
  signingKeyPem?: string
  // Changes the email after signing, as an attacker would
  tamper?: boolean
}

const iso = (d: Date) => d.toISOString()

// A base64 SAMLResponse with a signed assertion, as the IdP posts it to the ACS URL
export function samlResponse(idp: TestIdp, sp: { entityId: string; acsUrl: string }, o: AssertionOptions = {}): string {
  const now = o.issuedAt ?? new Date()
  const notOnOrAfter = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60 * 1000)
  const assertionId = o.assertionId ?? `_a${randomUUID().replace(/-/g, '')}`
  const email = o.email ?? 'jane@acme.example'
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : ''
  const assertion = `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso(now)}" Version="2.0"><saml2:Issuer>${o.issuer ?? idp.entityId}</saml2:Issuer><saml2:Subject><saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? email}</saml2:NameID><saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml2:SubjectConfirmationData${irt} NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${o.recipient ?? sp.acsUrl}"/></saml2:SubjectConfirmation></saml2:Subject><saml2:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml2:AudienceRestriction><saml2:Audience>${o.audience ?? sp.entityId}</saml2:Audience></saml2:AudienceRestriction></saml2:Conditions><saml2:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}"><saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef></saml2:AuthnContext></saml2:AuthnStatement><saml2:AttributeStatement><saml2:Attribute Name="email" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified"><saml2:AttributeValue>${email}</saml2:AttributeValue></saml2:Attribute><saml2:Attribute Name="firstName"><saml2:AttributeValue>${(o.name ?? 'Jane Doe').split(' ')[0]}</saml2:AttributeValue></saml2:Attribute><saml2:Attribute Name="lastName"><saml2:AttributeValue>${(o.name ?? 'Jane Doe').split(' ')[1] ?? ''}</saml2:AttributeValue></saml2:Attribute></saml2:AttributeStatement></saml2:Assertion>`

  const sig = new SignedXml({
    privateKey: o.signingKeyPem ?? idp.privateKeyPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  })
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  })
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } })
  let signed = sig.getSignedXml()
  if (o.tamper) signed = signed.replaceAll(email, 'mallory@acme.example')

  const response = `<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" Destination="${sp.acsUrl}" ID="_r${randomUUID().replace(/-/g, '')}"${irt} IssueInstant="${iso(now)}" Version="2.0"><saml2:Issuer xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">${o.issuer ?? idp.entityId}</saml2:Issuer><saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status>${signed}</saml2p:Response>`
  return Buffer.from(response).toString('base64')
}
