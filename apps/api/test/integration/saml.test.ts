import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DOMParser } from '@xmldom/xmldom'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { METADATA_URL_FAILED, parseIdpMetadata } from '../../src/ee/sso/saml-metadata.js'
import { env } from '../../src/env.js'
import { call, createOrg, createUser, sessionCookie, type TestUser } from './helpers.js'
import { disableEnterprise, enableEnterprise, removeTestSigningKeys } from './enterprise.js'
import { createIdp, samlResponse, type AssertionOptions, type TestIdp } from './saml-idp.js'

const original = { selfHosted: env.selfHosted }
const sp = { entityId: `${env.appUrl}/api/auth/sso/saml/metadata`, acsUrl: `${env.appUrl}/api/auth/sso/saml/acs` }
const failed = `${env.appUrl}/login?error=sso_failed`
// A response that answers no request of this browser, from an IdP no connection accepts unasked
const unmatched = `${env.appUrl}/login?error=sso_unavailable`

let idp: TestIdp
let admin: TestUser
let connectionId: string | null

beforeEach(async () => {
  env.selfHosted = true
  admin = await createUser({ admin: true, email: 'admin@acme.example' })
  await enableEnterprise()
  idp = createIdp()
  connectionId = null
})

afterEach(() => {
  env.selfHosted = original.selfHosted
  removeTestSigningKeys()
  vi.restoreAllMocks()
})

type Described = { id: string; protocol: string; enabled: boolean; saml: { idpEntityId: string; ssoUrl: string; certificates: number } }

// Adds the SAML connection the first time, changes it after
async function configure(extra: Record<string, unknown> = {}): Promise<Described> {
  const json = { protocol: 'saml', name: 'Okta', metadataXml: idp.metadata, enabled: true, ...extra }
  const res = connectionId
    ? await call(`/api/admin/sso/${connectionId}`, { method: 'PUT', cookie: admin.cookie, json })
    : await call('/api/admin/sso', { cookie: admin.cookie, json })
  expect(res.status).toBe(connectionId ? 200 : 201)
  const body = (await res.json()) as Described
  connectionId = body.id
  return body
}

// Starts a sign-in like the browser does; returns the request id and the browser's flow cookie
async function start(next = '/app') {
  const res = await call(`/api/auth/sso/${connectionId}?next=${encodeURIComponent(next)}`)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(idp.ssoUrl)
  expect(location.searchParams.get('SAMLRequest')).toBeTruthy()
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('saml_request='))!
  expect(cookie).toMatch(/SameSite=None/i)
  expect(cookie).toMatch(/Secure/i)
  const requestId = cookie.split(';')[0].split('=')[1]
  return { requestId, cookie: `saml_request=${requestId}`, relayState: location.searchParams.get('RelayState') ?? '' }
}

async function post(response: string, opts: { cookie?: string; relayState?: string } = {}) {
  return call('/api/auth/sso/saml/acs', { cookie: opts.cookie, form: { SAMLResponse: response, RelayState: opts.relayState ?? '' } })
}

async function signIn(o: AssertionOptions = {}, next = '/app') {
  const flow = await start(next)
  const res = await post(samlResponse(idp, sp, { inResponseTo: flow.requestId, ...o }), { cookie: flow.cookie, relayState: flow.relayState })
  return res
}

describe('SAML configuration', () => {
  it('reads the IdP from pasted metadata', async () => {
    const body = await configure()
    expect(body).toMatchObject({ protocol: 'saml', enabled: true, saml: { idpEntityId: idp.entityId, ssoUrl: idp.ssoUrl, certificates: 1 } })
    const listing = await (await call('/api/admin/sso', { cookie: admin.cookie })).json()
    expect(listing.saml).toEqual({ entityId: sp.entityId, acsUrl: sp.acsUrl })
    // Other settings change without sending the metadata again
    expect((await configure({ metadataXml: '', name: 'Okta SAML' })).saml.idpEntityId).toBe(idp.entityId)
  })

  it('refuses metadata that is not an IdP’s', async () => {
    const res = await call('/api/admin/sso', { cookie: admin.cookie, json: { protocol: 'saml', name: 'Okta', metadataXml: '<html></html>' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field: 'metadataXml' })
    expect(parseIdpMetadata(`<!DOCTYPE x [<!ENTITY a "b">]>${idp.metadata}`).ok).toBe(false)
    expect(parseIdpMetadata(idp.metadata.replace(/<md:KeyDescriptor[\s\S]*<\/md:KeyDescriptor>/, '')).ok).toBe(false)
  })

  it('reads the IdP from its metadata URL, and says only that it couldn’t when that fails', async () => {
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/moved') res.writeHead(302, { location: '/metadata' }).end()
      else if (req.url === '/metadata') res.end(idp.metadata)
      else if (req.url === '/big') res.end(`${idp.metadata}${' '.repeat(1024 * 1024)}`)
      else res.end('<html></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect((await configure({ metadataXml: '', metadataUrl: `${base}/metadata` })).saml.idpEntityId).toBe(idp.entityId)
      for (const url of [`${base}/moved`, `${base}/page`, `${base}/big`, 'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:1/']) {
        const res = await call('/api/admin/sso', { cookie: admin.cookie, json: { protocol: 'saml', name: 'Okta', metadataUrl: url } })
        expect(res.status, url).toBe(400)
        expect(await res.json(), url).toEqual({ error: METADATA_URL_FAILED, field: 'metadataUrl' })
      }
      // The redirect wasn't followed
      expect(hits).toEqual(['/metadata', '/moved', '/page', '/big'])
    } finally {
      server.close()
    }
  })

  it('serves SP metadata with the ACS URL', async () => {
    await configure()
    const res = await call('/api/auth/sso/saml/metadata')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain(`entityID="${sp.entityId}"`)
    expect(xml).toContain(`Location="${sp.acsUrl}"`)
  })

  it('is for instance admins only', async () => {
    const other = await createUser()
    expect((await call('/api/admin/sso', { cookie: other.cookie, json: { protocol: 'saml', name: 'x', metadataXml: idp.metadata } })).status).toBe(403)
  })

  it('shows the button on the sign-in page only while enabled', async () => {
    expect((await (await call('/api/config')).json()).sso).toEqual([])
    const connection = await configure()
    expect((await (await call('/api/config')).json()).sso).toEqual([{ id: connection.id, name: 'Okta' }])
    await configure({ enabled: false })
    expect((await (await call('/api/config')).json()).sso).toEqual([])
  })
})

describe('SAML sign-in', () => {
  it('creates the account from a valid assertion and joins the organization', async () => {
    const org = await createOrg(admin)
    await configure({ organizationId: org.id })
    const res = await signIn({}, '/a/abc123')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${env.appUrl}/a/abc123`)
    expect(sessionCookie(res)).toBeTruthy()
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, 'jane@acme.example'))
    expect(user).toMatchObject({ name: 'Jane Doe', isAdmin: false })
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id))
    expect(membership).toMatchObject({ organizationId: org.id, role: 'member' })
    const [identity] = await db.select().from(schema.ssoIdentities).where(eq(schema.ssoIdentities.userId, user.id))
    expect(identity.subject).toBe('jane@acme.example')
  })

  it('signs in to an existing account with the same email, and later by NameID', async () => {
    const existing = await createUser({ email: 'jane@acme.example' })
    // Without domains the IdP could name any address, so it doesn't link existing accounts
    await configure()
    expect((await signIn()).headers.get('location')).toBe(`${env.appUrl}/login?error=sso_link`)
    await configure({ allowedDomains: ['acme.example'] })
    const first = await signIn()
    expect(sessionCookie(first)).toBeTruthy()
    const second = await signIn({ email: 'jane.doe@acme.example', nameId: 'jane@acme.example' })
    expect(sessionCookie(second)).toBeTruthy()
    expect(await db.select().from(schema.users)).toHaveLength(2)
    const [identity] = await db.select().from(schema.ssoIdentities)
    expect(identity.userId).toBe(existing.id)
  })

  it('never signs in to an instance admin’s existing account', async () => {
    await configure({ allowedDomains: ['acme.example'] })
    const res = await signIn({ email: admin.email })
    expect(res.headers.get('location')).toBe(`${env.appUrl}/login?error=sso_admin`)
    expect(sessionCookie(res)).toBeNull()
    expect(await db.select().from(schema.ssoIdentities)).toHaveLength(0)
  })

  it('creates accounts when sign-up is closed only for a connection with domains', async () => {
    await configure()
    await db.update(schema.instanceSettings).set({ signupPolicy: 'invite-only' })
    expect((await signIn()).headers.get('location')).toBe(`${env.appUrl}/login?error=signup_closed`)
    await configure({ allowedDomains: ['acme.example'] })
    expect(sessionCookie(await signIn())).toBeTruthy()
  })

  it('refuses addresses outside the connection’s domains', async () => {
    await configure({ allowedDomains: ['other.example'] })
    expect((await signIn()).headers.get('location')).toBe(`${env.appUrl}/login?error=sso_domain`)
  })

  it('counts as single sign-on where a connection is required', async () => {
    await configure({ allowedDomains: ['acme.example'], required: true })
    expect(sessionCookie(await signIn())).toBeTruthy()
  })

  it('refuses a suspended account', async () => {
    await configure()
    await db.insert(schema.users).values({ email: 'jane@acme.example', suspendedAt: new Date() })
    const res = await signIn()
    expect(res.headers.get('location')).toBe(`${env.appUrl}/login?error=account_suspended`)
  })

  it('refuses an assertion signed by another key', async () => {
    await configure()
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const res = await signIn({ signingKeyPem: other })
    expect(res.headers.get('location')).toBe(failed)
    expect(sessionCookie(res)).toBeNull()
  })

  it('refuses an assertion changed after signing', async () => {
    await configure()
    const res = await signIn({ tamper: true })
    expect(res.headers.get('location')).toBe(failed)
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'mallory@acme.example'))).toHaveLength(0)
  })

  it('refuses the wrong audience', async () => {
    await configure()
    const res = await signIn({ audience: 'https://other.example/saml' })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('refuses the wrong recipient', async () => {
    await configure()
    const res = await signIn({ recipient: 'https://other.example/acs' })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('refuses the wrong issuer', async () => {
    await configure()
    const res = await signIn({ issuer: 'https://evil.example' })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('refuses an expired assertion', async () => {
    await configure()
    const res = await signIn({ issuedAt: new Date(Date.now() - 60 * 60 * 1000), notOnOrAfter: new Date(Date.now() - 55 * 60 * 1000) })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('refuses an assertion older than the maximum age, whatever NotOnOrAfter says', async () => {
    await configure()
    const res = await signIn({ issuedAt: new Date(Date.now() - 30 * 60 * 1000), notOnOrAfter: new Date(Date.now() + 60 * 60 * 1000) })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('refuses a replayed response', async () => {
    await configure()
    const flow = await start()
    const response = samlResponse(idp, sp, { inResponseTo: flow.requestId })
    expect(sessionCookie(await post(response, { cookie: flow.cookie }))).toBeTruthy()
    const again = await post(response, { cookie: flow.cookie })
    expect(again.headers.get('location')).toBe(unmatched)
    expect(sessionCookie(again)).toBeNull()
  })

  it('refuses a replayed assertion even when IdP-initiated sign-in is on', async () => {
    await configure({ allowIdpInitiated: true })
    const response = samlResponse(idp, sp, { inResponseTo: null })
    expect(sessionCookie(await post(response))).toBeTruthy()
    const again = await post(response)
    expect(again.headers.get('location')).toBe(failed)
  })

  it('refuses IdP-initiated responses unless turned on, without reading them', async () => {
    await configure()
    const response = samlResponse(idp, sp, { inResponseTo: null })
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    const res = await post(response)
    expect(res.headers.get('location')).toBe(unmatched)
    expect(parse).not.toHaveBeenCalled()
  })

  it('refuses a response for a request this server never sent', async () => {
    await configure()
    const res = await post(samlResponse(idp, sp, { inResponseTo: '_made-up' }), { cookie: 'saml_request=_made-up' })
    expect(res.headers.get('location')).toBe(unmatched)
  })

  it('refuses a response to another browser’s sign-in', async () => {
    await configure()
    const victim = await start()
    const attacker = await start()
    const res = await post(samlResponse(idp, sp, { inResponseTo: attacker.requestId }), { cookie: victim.cookie })
    expect(res.headers.get('location')).toBe(failed)
  })

  it('only follows same-site paths from RelayState', async () => {
    await configure()
    const flow = await start()
    const res = await post(samlResponse(idp, sp, { inResponseTo: flow.requestId }), { cookie: flow.cookie, relayState: 'https://evil.example/' })
    expect(res.headers.get('location')).toBe(`${env.appUrl}/app`)
  })
})

describe('SAML without a license', () => {
  it('hides the button and refuses sign-ins', async () => {
    await configure()
    await disableEnterprise()
    expect((await (await call('/api/config')).json()).sso).toEqual([])
    expect((await call(`/api/auth/sso/${connectionId}`)).headers.get('location')).toBe(`${env.appUrl}/login?error=sso_unavailable`)
    const res = await post(samlResponse(idp, sp))
    expect(res.headers.get('location')).toBe(`${env.appUrl}/login?error=sso_unavailable`)
    expect((await call('/api/auth/sso/saml/metadata')).status).toBe(404)
  })

  it('reads no response, even for a connection that takes them unasked', async () => {
    await configure({ allowIdpInitiated: true })
    await disableEnterprise()
    const response = samlResponse(idp, sp, { inResponseTo: null })
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    const res = await post(response)
    expect(res.headers.get('location')).toBe(`${env.appUrl}/login?error=sso_unavailable`)
    expect(parse).not.toHaveBeenCalled()
  })

  it('refuses a flow started while licensed once the license is gone', async () => {
    await configure()
    const flow = await start()
    await disableEnterprise()
    const res = await post(samlResponse(idp, sp, { inResponseTo: flow.requestId }), { cookie: flow.cookie })
    expect(res.headers.get('location')).toBe(`${env.appUrl}/login?error=sso_unavailable`)
  })

  it('can’t be set up', async () => {
    await disableEnterprise()
    const res = await call('/api/admin/sso', { cookie: admin.cookie, json: { protocol: 'saml', name: 'Okta', metadataXml: idp.metadata } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'enterprise_required' })
  })

  it('keeps working in the grace period after the license expires', async () => {
    await enableEnterprise({ expiresAt: new Date(Date.now() - 86_400_000) })
    await configure()
    expect(sessionCookie(await signIn())).toBeTruthy()
  })

  it('is off on the hosted service', async () => {
    await configure()
    env.selfHosted = false
    expect((await (await call('/api/config')).json()).sso).toEqual([])
    expect((await call('/api/admin/sso', { cookie: admin.cookie })).status).toBe(404)
    expect((await call('/api/auth/sso/saml/metadata')).status).toBe(404)
    expect((await call(`/api/auth/sso/${connectionId}`)).status).toBe(404)
    expect((await post(samlResponse(idp, sp))).status).toBe(404)
  })
})
