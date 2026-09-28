import { generateKeyPairSync } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditSettled } from '../../src/audit.js'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { readSigningKey, signLicense } from '../../src/ee/licenses.js'
import { env } from '../../src/env.js'
import { LICENSE_PUBLIC_KEYS } from '../../src/license.js'
import { Authenticator } from './authenticator.js'
import { call, createOrg, createUser, sessionCookie, type TestUser } from './helpers.js'
import { startProvider, type FakeProvider } from './oidc-provider.js'

const DAY = 24 * 60 * 60 * 1000
const PASSWORD = 'correct horse battery'
const APP = 'http://localhost:5177'

const { privateKey } = generateKeyPairSync('ed25519')
const signer = readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))!

const original = { selfHosted: env.selfHosted, smtpHost: env.smtp.host }
let provider: FakeProvider

beforeAll(async () => {
  provider = await startProvider()
})

afterAll(async () => {
  await provider.close()
})

beforeEach(() => {
  env.selfHosted = true
  LICENSE_PUBLIC_KEYS[signer.keyId] = signer.publicKey
  provider.claims = { sub: 'user-1', email: 'ada@acme.example', email_verified: true, name: 'Ada Lovelace' }
  provider.signWithWrongKey = false
  provider.nonceOverride = null
})

afterEach(() => {
  env.selfHosted = original.selfHosted
  env.smtp.host = original.smtpHost
  delete LICENSE_PUBLIC_KEYS[signer.keyId]
})

async function license(expiresInDays = 365) {
  const key = signLicense(
    {
      id: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11',
      customer: 'Acme Inc',
      email: 'it@acme.example',
      seats: 50,
      issuedAt: new Date(Date.now() - DAY).toISOString(),
      expiresAt: new Date(Date.now() + expiresInDays * DAY).toISOString(),
    },
    signer,
  )
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', licenseKey: key })
    .onConflictDoUpdate({
      target: schema.instanceSettings.id,
      set: { licenseKey: key },
    })
}

async function adminUser() {
  return createUser({ email: 'admin@acme.example', admin: true })
}

type ConnectionBody = Partial<{
  name: string
  issuer: string
  clientId: string
  clientSecret: string
  trustEmail: boolean
  allowedDomains: string[]
  required: boolean
  enabled: boolean
  organizationId: string | null
}>

async function addConnection(admin: TestUser, body: ConnectionBody = {}) {
  const res = await call('/api/admin/sso', {
    cookie: admin.cookie,
    json: { name: 'Okta', issuer: provider.issuer, clientId: provider.clientId, clientSecret: provider.clientSecret, enabled: true, ...body },
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

function cookieFrom(res: Response, name: string): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  const value = header?.split(';')[0]
  return value && value !== `${name}=` ? value : null
}

// The whole round trip: the app sends the browser to the provider, the provider sends it back
async function signIn(connectionId: string, opts: { cookie?: string; start?: string; tamper?: (q: URLSearchParams) => void } = {}) {
  const start = await call(opts.start ?? `/api/auth/sso/${connectionId}?next=/settings`, { cookie: opts.cookie })
  expect(start.status).toBe(302)
  const location = start.headers.get('location')!
  expect(location.startsWith(`${provider.issuer}/authorize?`)).toBe(true)
  const flow = cookieFrom(start, 'sso_flow')
  expect(flow).toBeTruthy()
  const { code, state } = provider.authorize(location)
  const query = new URLSearchParams({ code, state })
  opts.tamper?.(query)
  const cookie = [flow, opts.cookie].filter(Boolean).join('; ')
  const res = await call(`/api/auth/sso/oidc/callback?${query}`, { cookie })
  return { res, location: res.headers.get('location') ?? '', session: sessionCookie(res), authorizationUrl: new URL(location) }
}

async function userByEmail(email: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  return row
}

async function withPassword(user: TestUser) {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(schema.users.id, user.id))
}

const passwordLogin = (email: string) => call('/api/auth/password/login', { json: { email, password: PASSWORD } })

describe('SSO with OpenID Connect', () => {
  it('shows the button, signs a new person in and makes their account', async () => {
    await license()
    const admin = await adminUser()
    const org = await createOrg(admin, 'Acme', 'acme')
    const conn = await addConnection(admin, { allowedDomains: ['acme.example'], organizationId: org.id })

    const config = await (await call('/api/config')).json()
    expect(config.sso).toEqual([{ id: conn.id, name: 'Okta' }])

    const { res, location, session, authorizationUrl } = await signIn(conn.id)
    // The authorization request: PKCE, state and nonce, and a redirect URI from APP_URL
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/sso/oidc/callback`)
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy()
    expect(authorizationUrl.searchParams.get('nonce')).toBeTruthy()
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid email profile')

    expect(res.status).toBe(302)
    expect(location).toBe(`${APP}/settings`)
    expect(session).toBeTruthy()
    const me = await (await call('/api/me', { cookie: session! })).json()
    expect(me).toMatchObject({ email: 'ada@acme.example', name: 'Ada Lovelace', isAdmin: false })
    expect(me.organizations).toEqual([expect.objectContaining({ id: org.id, role: 'member' })])

    const identities = await db.select().from(schema.ssoIdentities)
    expect(identities).toEqual([expect.objectContaining({ connectionId: conn.id, subject: 'user-1', email: 'ada@acme.example', userId: me.id })])
  })

  it('records the sign-in and the join in the organization’s audit log', async () => {
    await license()
    const admin = await adminUser()
    const org = await createOrg(admin, 'Acme', 'acme')
    const conn = await addConnection(admin, { allowedDomains: ['acme.example'], organizationId: org.id })
    await signIn(conn.id)
    await signIn(conn.id)
    await auditSettled()
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, org.id))
    expect(events.filter((e) => e.action === 'member.joined')).toEqual([
      expect.objectContaining({ actorEmail: 'ada@acme.example', details: { role: 'member', via: 'single sign-on', connection: 'Okta' } }),
    ])
    expect(events.filter((e) => e.action === 'sign_in.succeeded' && e.actorEmail === 'ada@acme.example').map((e) => e.details)).toEqual([
      { method: 'sso' },
      { method: 'sso' },
    ])
  })

  it('records a sign-in turned away because single sign-on is required', async () => {
    await license()
    const admin = await adminUser()
    const org = await createOrg(admin, 'Acme', 'acme')
    const ada = await createUser({ email: 'ada@acme.example' })
    await db.insert(schema.memberships).values({ userId: ada.id, organizationId: org.id, role: 'member' })
    await withPassword(ada)
    await addConnection(admin, { allowedDomains: ['acme.example'], required: true })
    await passwordLogin(ada.email)
    await auditSettled()
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'sign_in.failed'))
    expect(events).toEqual([
      expect.objectContaining({ organizationId: org.id, actorEmail: 'ada@acme.example', details: { reason: 'single sign-on required' } }),
    ])
  })

  it('keeps the account linked to the subject when the address changes at the provider', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const first = await signIn(conn.id)
    const firstMe = await (await call('/api/me', { cookie: first.session! })).json()

    provider.claims = { ...provider.claims, email: 'ada.lovelace@acme.example' }
    const second = await signIn(conn.id)
    const secondMe = await (await call('/api/me', { cookie: second.session! })).json()
    expect(secondMe.id).toBe(firstMe.id)
    expect(secondMe.email).toBe('ada@acme.example')
  })

  it('links an existing account with the same verified address', async () => {
    await license()
    const admin = await adminUser()
    const ada = await createUser({ email: 'ada@acme.example' })
    const conn = await addConnection(admin)
    const { session } = await signIn(conn.id)
    expect((await (await call('/api/me', { cookie: session! })).json()).id).toBe(ada.id)
    expect(await db.select().from(schema.users)).toHaveLength(2)
  })

  it('refuses an ID token signed with a key the provider doesn’t publish', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    provider.signWithWrongKey = true
    const { location, session } = await signIn(conn.id)
    expect(location).toBe(`${APP}/login?error=sso_failed`)
    expect(session).toBeNull()
    expect(await userByEmail('ada@acme.example')).toBeUndefined()
  })

  it('refuses a wrong state', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const before = provider.tokenRequests
    const { location, session } = await signIn(conn.id, { tamper: (q) => q.set('state', 'forged') })
    expect(location).toBe(`${APP}/login?error=sso_failed`)
    expect(session).toBeNull()
    // Checked before the code is spent
    expect(provider.tokenRequests).toBe(before)
  })

  it('refuses a callback without the cookie of the flow it belongs to', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const start = await call(`/api/auth/sso/${conn.id}`)
    const { code, state } = provider.authorize(start.headers.get('location')!)
    const res = await call(`/api/auth/sso/oidc/callback?${new URLSearchParams({ code, state })}`)
    expect(res.headers.get('location')).toBe(`${APP}/login?error=sso_failed`)
    expect(sessionCookie(res)).toBeNull()
  })

  it('refuses an ID token with the wrong nonce', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    provider.nonceOverride = 'replayed'
    const { location, session } = await signIn(conn.id)
    expect(location).toBe(`${APP}/login?error=sso_failed`)
    expect(session).toBeNull()
  })

  it('refuses an address the provider hasn’t verified, unless the connection trusts it', async () => {
    await license()
    const admin = await adminUser()
    await createUser({ email: 'ada@acme.example' })
    const conn = await addConnection(admin)
    provider.claims = { ...provider.claims, email_verified: false }
    const refused = await signIn(conn.id)
    expect(refused.location).toBe(`${APP}/login?error=sso_unverified`)
    expect(refused.session).toBeNull()
    expect(await db.select().from(schema.ssoIdentities)).toHaveLength(0)

    delete provider.claims.email_verified
    expect((await signIn(conn.id)).location).toBe(`${APP}/login?error=sso_unverified`)

    const res = await call(`/api/admin/sso/${conn.id}`, {
      method: 'PUT',
      cookie: admin.cookie,
      json: { name: 'Entra ID', issuer: provider.issuer, clientId: provider.clientId, trustEmail: true, enabled: true },
    })
    expect(res.status).toBe(200)
    expect((await signIn(conn.id)).session).toBeTruthy()
  })

  it('refuses addresses outside the connection’s domains', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin, { allowedDomains: ['example.org'] })
    const { location, session } = await signIn(conn.id)
    expect(location).toBe(`${APP}/login?error=sso_domain`)
    expect(session).toBeNull()
  })

  it('follows the sign-up policy for new accounts when the connection lists no domains', async () => {
    await license()
    const admin = await adminUser()
    await db.update(schema.instanceSettings).set({ signupPolicy: 'invite-only' })
    const open = await addConnection(admin)
    expect((await signIn(open.id)).location).toBe(`${APP}/login?error=signup_closed`)

    const listed = await addConnection(admin, { name: 'Okta 2', allowedDomains: ['acme.example'] })
    expect((await signIn(listed.id)).session).toBeTruthy()
  })

  it('sends a suspended person back', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    await signIn(conn.id)
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.email, 'ada@acme.example'))
    expect((await signIn(conn.id)).location).toBe(`${APP}/login?error=account_suspended`)
  })

  it('keeps a turned-off connection off the sign-in page and out of use', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin, { enabled: false })
    expect((await (await call('/api/config')).json()).sso).toEqual([])
    const res = await call(`/api/auth/sso/${conn.id}`)
    expect(res.headers.get('location')).toBe(`${APP}/login?error=sso_unavailable`)
  })

  it('ignores ?next= that leaves the app', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const { location } = await signIn(conn.id, { start: `/api/auth/sso/${conn.id}?next=//evil.example/x` })
    expect(location).toBe(`${APP}/app`)
  })
})

describe('requiring SSO', () => {
  it('turns away password, email link and passkey sign-ins, but not instance admins', async () => {
    await license()
    const admin = await adminUser()
    await withPassword(admin)
    const ada = await createUser({ email: 'ada@acme.example' })
    await withPassword(ada)
    const outsider = await createUser({ email: 'guest@example.org' })
    await withPassword(outsider)

    // A passkey added before SSO was required
    const authenticator = new Authenticator()
    const options = await call('/api/me/security/passkeys/options', { method: 'POST', cookie: ada.cookie })
    const added = await call('/api/me/security/passkeys', {
      cookie: ada.cookie,
      json: { name: 'Laptop', response: authenticator.register(await options.json()) },
    })
    expect(added.status).toBe(201)

    await addConnection(admin, { allowedDomains: ['acme.example'], required: true })

    const blocked = await passwordLogin(ada.email)
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toEqual({ redirect: `${APP}/login?error=sso_required` })
    expect(sessionCookie(blocked)).toBeNull()

    const passkeyOptions = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    const passkey = await call('/api/auth/passkey', { json: { response: authenticator.authenticate(passkeyOptions) } })
    expect(passkey.status).toBe(403)
    expect((await passkey.json()).code).toBe('sso_required')
    expect(sessionCookie(passkey)).toBeNull()

    // Break-glass: the instance admin, at the same domain, still signs in with a password
    const adminLogin = await passwordLogin(admin.email)
    expect(await adminLogin.json()).toEqual({ redirect: `${APP}/app` })
    expect(sessionCookie(adminLogin)).toBeTruthy()

    // Addresses outside the connection's domains aren't held to it
    expect(sessionCookie(await passwordLogin(outsider.email))).toBeTruthy()
  })

  it('holds everyone but the admins to it when the connection lists no domains, and SSO itself still works', async () => {
    await license()
    const admin = await adminUser()
    const guest = await createUser({ email: 'guest@example.org' })
    await withPassword(guest)
    const conn = await addConnection(admin, { required: true })
    expect(await (await passwordLogin(guest.email)).json()).toEqual({ redirect: `${APP}/login?error=sso_required` })
    expect((await signIn(conn.id)).session).toBeTruthy()
  })

  it('stops password sign-up at a required domain on a server without email', async () => {
    await license()
    env.smtp.host = ''
    const admin = await adminUser()
    await addConnection(admin, { allowedDomains: ['acme.example'], required: true })
    const res = await call('/api/auth/password/sign-up', { json: { email: 'new@acme.example', password: PASSWORD } })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('sso_required')
    const other = await call('/api/auth/password/sign-up', { json: { email: 'new@example.org', password: PASSWORD } })
    expect(other.status).toBe(201)
  })
})

describe('without a license', () => {
  it('hides the buttons, stops SSO, and lets people in the other ways', async () => {
    await license()
    const admin = await adminUser()
    const ada = await createUser({ email: 'ada@acme.example' })
    await withPassword(ada)
    const conn = await addConnection(admin, { required: true })
    await db.update(schema.instanceSettings).set({ licenseKey: null })

    expect((await (await call('/api/config')).json()).sso).toEqual([])
    expect((await call(`/api/auth/sso/${conn.id}`)).headers.get('location')).toBe(`${APP}/login?error=sso_unavailable`)
    expect(sessionCookie(await passwordLogin(ada.email))).toBeTruthy()
    const adminApi = await call('/api/admin/sso', { cookie: admin.cookie })
    expect(adminApi.status).toBe(403)
    expect((await adminApi.json()).code).toBe('enterprise_required')
    // Nothing is deleted
    expect(await db.select().from(schema.ssoConnections)).toHaveLength(1)
  })

  it('stops a sign-in already on its way at the provider', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const start = await call(`/api/auth/sso/${conn.id}`)
    const flow = cookieFrom(start, 'sso_flow')!
    const { code, state } = provider.authorize(start.headers.get('location')!)
    await db.update(schema.instanceSettings).set({ licenseKey: null })
    const res = await call(`/api/auth/sso/oidc/callback?${new URLSearchParams({ code, state })}`, { cookie: flow })
    expect(res.headers.get('location')).toBe(`${APP}/login?error=sso_unavailable`)
  })

  it('keeps SSO on during the grace period after the license expires', async () => {
    await license(-3)
    const admin = await adminUser()
    const conn = await addConnection(admin)
    expect((await signIn(conn.id)).session).toBeTruthy()
  })

  it('is off on the hosted service', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    env.selfHosted = false
    expect((await (await call('/api/config')).json()).sso).toEqual([])
    expect((await call(`/api/auth/sso/${conn.id}`)).status).toBe(404)
    expect((await call('/api/admin/sso', { cookie: admin.cookie })).status).toBe(404)
  })
})

describe('configuring SSO', () => {
  it('is for instance admins only', async () => {
    await license()
    const user = await createUser()
    expect((await call('/api/admin/sso', { cookie: user.cookie })).status).toBe(403)
    expect((await call('/api/admin/sso')).status).toBe(401)
  })

  it('checks the provider on saving and never shows or stores the secret in the clear', async () => {
    await license()
    const admin = await adminUser()
    const bad = await call('/api/admin/sso', {
      cookie: admin.cookie,
      json: { name: 'Okta', issuer: `${provider.issuer}/nothing-here`, clientId: 'x', clientSecret: 'y' },
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).field).toBe('issuer')

    const missing = await call('/api/admin/sso', { cookie: admin.cookie, json: { name: 'Okta', issuer: provider.issuer, clientId: 'x' } })
    expect((await missing.json()).field).toBe('clientSecret')

    const conn = await addConnection(admin)
    const [row] = await db.select().from(schema.ssoConnections)
    expect(row.secret).toBeTruthy()
    expect(row.secret).not.toContain(provider.clientSecret)
    expect(JSON.stringify(row.config)).not.toContain(provider.clientSecret)

    const listing = await (await call('/api/admin/sso', { cookie: admin.cookie })).json()
    expect(listing.redirectUri).toBe(`${APP}/api/auth/sso/oidc/callback`)
    expect(listing.connections).toEqual([expect.objectContaining({ id: conn.id, issuer: provider.issuer, hasClientSecret: true })])
    expect(JSON.stringify(listing)).not.toContain(provider.clientSecret)

    // Saving without a new secret keeps the old one working
    const kept = await call(`/api/admin/sso/${conn.id}`, {
      method: 'PUT',
      cookie: admin.cookie,
      json: { name: 'Okta', issuer: provider.issuer, clientId: provider.clientId, enabled: true },
    })
    expect(kept.status).toBe(200)
    expect((await signIn(conn.id)).session).toBeTruthy()

    expect((await call(`/api/admin/sso/${conn.id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(204)
    expect(await db.select().from(schema.ssoIdentities)).toHaveLength(0)
    expect(await db.select().from(schema.users)).toHaveLength(2)
  })

  it('tests a connection without signing anyone in', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin, { enabled: false, allowedDomains: ['example.org'] })
    const { res, location, session } = await signIn(conn.id, { start: `/api/admin/sso/${conn.id}/test`, cookie: admin.cookie })
    expect(location).toBe(`${APP}/admin?sso-test=1#sso`)
    expect(session).toBeNull()
    expect(await userByEmail('ada@acme.example')).toBeUndefined()

    const testCookie = cookieFrom(res, 'sso_test')!
    const result = await call('/api/admin/sso/test-result', { cookie: `${admin.cookie}; ${testCookie}` })
    expect(await result.json()).toEqual({
      connectionId: conn.id,
      ok: true,
      subject: 'user-1',
      email: 'ada@acme.example',
      emailVerified: true,
      name: 'Ada Lovelace',
      accepted: false,
    })
  })

  it('doesn’t turn a test started by an admin into someone else’s sign-in', async () => {
    await license()
    const admin = await adminUser()
    const conn = await addConnection(admin)
    const start = await call(`/api/admin/sso/${conn.id}/test`, { cookie: admin.cookie })
    const flow = cookieFrom(start, 'sso_flow')!
    const { code, state } = provider.authorize(start.headers.get('location')!)
    const res = await call(`/api/auth/sso/oidc/callback?${new URLSearchParams({ code, state })}`, { cookie: flow })
    expect(res.headers.get('location')).toBe(`${APP}/login?error=sso_failed`)
    expect(sessionCookie(res)).toBeNull()
  })
})
