import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditSettled } from '../../src/audit.js'
import { autoJoin } from '../../src/auto-join.js'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { enableEnterprise, removeTestSigningKeys } from './enterprise.js'
import { addMember, call, createOrg, createUser, sessionCookie, type TestUser } from './helpers.js'

const original = { selfHosted: env.selfHosted, google: { ...env.google } }

beforeEach(() => {
  env.selfHosted = true
})

afterEach(async () => {
  await auditSettled()
  env.selfHosted = original.selfHosted
  Object.assign(env.google, original.google)
  vi.unstubAllGlobals()
  removeTestSigningKeys()
})

type Settings = {
  organization: { id: string; name: string; slug: string } | null
  domains: string[]
  updatedAt: string | null
  organizations: { id: string }[]
}

async function setUp() {
  const admin = await createUser({ email: 'admin@acme.test', admin: true })
  const org = await createOrg(admin)
  return { admin, org }
}

async function configure(admin: TestUser, value: { organizationId: string | null; domains: string[] | string }) {
  const res = await call('/api/admin/auto-join', { method: 'PUT', cookie: admin.cookie, json: value })
  expect(res.status).toBe(200)
  return (await res.json()) as Settings
}

async function emailLink(email: string) {
  vi.mocked(sendSignInLink).mockClear()
  expect((await call('/api/auth/email', { json: { email } })).status).toBe(204)
  const token = new URL(vi.mocked(sendSignInLink).mock.calls[0][1]).searchParams.get('token')
  const res = await call('/api/auth/email/confirm', { json: { token } })
  expect(res.status).toBe(200)
  return sessionCookie(res)!
}

async function withPassword(user: TestUser, opts: { unverified?: boolean } = {}) {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword('correct horse battery'), emailUnverified: opts.unverified ?? false })
    .where(eq(schema.users.id, user.id))
}

async function passwordSignIn(email: string) {
  const res = await call('/api/auth/password/login', { json: { email, password: 'correct horse battery' } })
  expect(res.status).toBe(200)
  return sessionCookie(res)!
}

async function googleSignIn(email: string, sub: string) {
  env.google.clientId = 'client'
  env.google.clientSecret = 'secret'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('token') ? Response.json({ access_token: 'google-token' }) : Response.json({ sub, email, email_verified: true, name: 'G' }),
    ),
  )
  const res = await call('/api/auth/google/callback?code=abc&state=s1', { cookie: 'google_state=s1; google_verifier=v1' })
  expect(res.status).toBe(302)
  return sessionCookie(res)!
}

async function roleIn(orgId: string, email: string) {
  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.users.email, email)))
  return row?.role ?? null
}

const me = async (cookie: string) => (await call('/api/me', { cookie })).json()

describe('the setting', () => {
  it('is off until an admin saves it, and only instance admins see or change it', async () => {
    const { admin, org } = await setUp()
    const res = await call('/api/admin/auto-join', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ organization: null, domains: [], updatedAt: null, organizations: [{ id: org.id, name: org.name, slug: org.slug }] })

    const owner = await createUser()
    await addMember(org.id, owner, 'owner')
    for (const method of ['GET', 'PUT']) {
      const json = method === 'PUT' ? { organizationId: org.id, domains: ['acme.test'] } : undefined
      expect((await call('/api/admin/auto-join', { method, cookie: owner.cookie, json })).status).toBe(403)
      expect((await call('/api/admin/auto-join', { method, json })).status).toBe(401)
    }

    const saved = await configure(admin, { organizationId: org.id, domains: ' @Acme.test, acme.example\nacme.test ' })
    expect(saved).toMatchObject({ organization: { id: org.id, name: 'Acme Inc', slug: 'acme' }, domains: ['acme.test', 'acme.example'] })
    expect(saved.updatedAt).toBeTruthy()
    // Saving it before the sign-up policy leaves sign-up open
    expect(await (await call('/api/admin/settings', { cookie: admin.cookie })).json()).toMatchObject({ signupPolicy: 'open' })

    expect(await configure(admin, { organizationId: null, domains: [] })).toMatchObject({ organization: null, domains: [] })
  })

  it('refuses what it can’t use', async () => {
    const { admin, org } = await setUp()
    const cases: [unknown, string, string][] = [
      [{ organizationId: org.id, domains: [] }, 'domains', 'Add at least one domain.'],
      [{ organizationId: org.id, domains: ['exa_mple.com'] }, 'domains', 'exa_mple.com is not a domain. List domains like example.com.'],
      [{ organizationId: org.id, domains: ['localhost'] }, 'domains', 'localhost is not a domain. List domains like example.com.'],
      [{ organizationId: org.id, domains: [42] }, 'domains', 'List domains like example.com.'],
      [{ organizationId: org.id, domains: Array.from({ length: 101 }, (_, i) => `d${i}.test`) }, 'domains', 'List at most 100 domains.'],
      [{ organizationId: 'acme', domains: ['acme.test'] }, 'organizationId', 'Choose an organization on this server.'],
      [{ organizationId: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11', domains: ['acme.test'] }, 'organizationId', 'Choose an organization on this server.'],
      [{ organizationId: 7, domains: ['acme.test'] }, 'organizationId', 'Choose an organization on this server.'],
    ]
    for (const [json, field, error] of cases) {
      const res = await call('/api/admin/auto-join', { method: 'PUT', cookie: admin.cookie, json })
      expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(400)
      expect(await res.json()).toEqual({ error, field })
    }
    expect((await (await call('/api/admin/auto-join', { cookie: admin.cookie })).json()).organization).toBeNull()
  })

  it('turns off when its organization is deleted', async () => {
    const { admin, org } = await setUp()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    const res = await call(`/api/admin/organizations/${org.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmSlug: 'acme' } })
    expect(res.status).toBe(204)
    expect(await (await call('/api/admin/auto-join', { cookie: admin.cookie })).json()).toMatchObject({ organization: null, domains: ['acme.test'] })
    // Signing in still works, and joins nothing
    const cookie = await emailLink('new@acme.test')
    expect(await me(cookie)).toMatchObject({ organizations: [], autoJoined: [] })
  })
})

describe('joining', () => {
  it('a new account at a listed domain joins as a member, sees a notice once, and the audit log says how', async () => {
    const { admin, org } = await setUp()
    await enableEnterprise()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })

    const cookie = await emailLink('Ada@ACME.test')
    const body = await me(cookie)
    expect(body.organizations).toEqual([expect.objectContaining({ id: org.id, role: 'member' })])
    expect(body.autoJoined).toEqual([{ organizationId: org.id, name: 'Acme Inc', slug: 'acme', domain: 'acme.test' }])

    expect((await call(`/api/me/auto-joins/${org.id}/dismiss`, { method: 'POST', cookie })).status).toBe(204)
    expect((await me(cookie)).autoJoined).toEqual([])
    // Someone else's notice, or nonsense, changes nothing
    expect((await call('/api/me/auto-joins/nope/dismiss', { method: 'POST', cookie })).status).toBe(204)
    expect((await call(`/api/me/auto-joins/${org.id}/dismiss`, { method: 'POST' })).status).toBe(401)

    await auditSettled()
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'member.joined'))
    expect(events).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        actorEmail: 'ada@acme.test',
        targetLabel: 'ada@acme.test',
        details: { role: 'member', via: 'email domain', domain: 'acme.test' },
      }),
    ])
  })

  it('an existing account joins at its next sign-in, by password, Google or an email link', async () => {
    const { admin, org } = await setUp()
    const byPassword = await createUser({ email: 'pat@acme.test' })
    await withPassword(byPassword)
    await createUser({ email: 'gus@acme.test' })
    await createUser({ email: 'eve@acme.test' })
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    expect(await roleIn(org.id, 'pat@acme.test')).toBeNull()

    await passwordSignIn('pat@acme.test')
    await googleSignIn('gus@acme.test', 'google-gus')
    await emailLink('eve@acme.test')
    for (const email of ['pat@acme.test', 'gus@acme.test', 'eve@acme.test']) expect(await roleIn(org.id, email), email).toBe('member')
  })

  it('an address nobody checked joins only once a sign-in proves it', async () => {
    const { admin, org } = await setUp()
    const squatter = await createUser({ email: 'cfo@acme.test' })
    await withPassword(squatter, { unverified: true })
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })

    await passwordSignIn('cfo@acme.test')
    expect(await roleIn(org.id, 'cfo@acme.test')).toBeNull()
    expect(await db.select().from(schema.autoJoins)).toEqual([])

    await emailLink('cfo@acme.test')
    expect(await roleIn(org.id, 'cfo@acme.test')).toBe('member')
  })

  it('leaves out other domains, subdomains and suspended accounts', async () => {
    const { admin, org } = await setUp()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    await emailLink('someone@other.test')
    await emailLink('someone@mail.acme.test')
    await emailLink('someone@acme.test.evil.test')
    const suspended = await createUser({ email: 'gone@acme.test' })
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, suspended.id))
    await autoJoin(suspended.id)

    const members = await db.select({ userId: schema.memberships.userId }).from(schema.memberships).where(eq(schema.memberships.organizationId, org.id))
    expect(members).toEqual([{ userId: admin.id }])
    expect(await db.select().from(schema.autoJoins)).toEqual([])
  })

  it('keeps the role of someone already a member, with no notice', async () => {
    const { admin, org } = await setUp()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    const cookie = await emailLink('admin@acme.test')
    expect(await roleIn(org.id, 'admin@acme.test')).toBe('owner')
    expect((await me(cookie)).autoJoined).toEqual([])
    expect(await db.select().from(schema.autoJoins)).toEqual([expect.objectContaining({ userId: admin.id, noticeSeenAt: expect.any(Date) })])
  })

  it('never adds back someone who was removed or left', async () => {
    const { admin, org } = await setUp()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    await emailLink('removed@acme.test')
    const leaverCookie = await emailLink('leaver@acme.test')
    const [removed] = await db.select().from(schema.users).where(eq(schema.users.email, 'removed@acme.test'))
    const [leaver] = await db.select().from(schema.users).where(eq(schema.users.email, 'leaver@acme.test'))

    expect((await call(`/api/organizations/${org.id}/members/${removed.id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(200)
    expect((await call(`/api/organizations/${org.id}/members/${leaver.id}`, { method: 'DELETE', cookie: leaverCookie })).status).toBe(204)

    const cookie = await emailLink('removed@acme.test')
    await emailLink('leaver@acme.test')
    expect(await roleIn(org.id, 'removed@acme.test')).toBeNull()
    expect(await roleIn(org.id, 'leaver@acme.test')).toBeNull()
    // Nor does a notice come back for an organization they are no longer in
    expect((await me(cookie)).autoJoined).toEqual([])
  })

  it('also never adds back a member who was there already and left', async () => {
    const { admin, org } = await setUp()
    const member = await createUser({ email: 'mo@acme.test' })
    await addMember(org.id, member, 'member')
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    await emailLink('mo@acme.test')
    expect((await call(`/api/organizations/${org.id}/members/${member.id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(200)
    await emailLink('mo@acme.test')
    expect(await roleIn(org.id, 'mo@acme.test')).toBeNull()
  })

  it('checks everyone again when the setting names another organization', async () => {
    const { admin, org } = await setUp()
    const other = await createOrg(admin, 'Acme Labs', 'acme-labs')
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    await emailLink('ada@acme.test')
    await configure(admin, { organizationId: other.id, domains: ['acme.test'] })
    const cookie = await emailLink('ada@acme.test')
    expect(await roleIn(org.id, 'ada@acme.test')).toBe('member')
    expect(await roleIn(other.id, 'ada@acme.test')).toBe('member')
    expect((await me(cookie)).autoJoined.map((n: { slug: string }) => n.slug)).toEqual(['acme', 'acme-labs'])
  })

  it('adds someone once when they sign in several times at once', async () => {
    const { admin, org } = await setUp()
    await enableEnterprise()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    const user = await createUser({ email: 'twice@acme.test' })
    await Promise.all(Array.from({ length: 5 }, () => autoJoin(user.id)))
    expect(await roleIn(org.id, 'twice@acme.test')).toBe('member')
    await auditSettled()
    expect(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'member.joined'))).toHaveLength(1)
  })

  it('works on the hosted service too, where joining finishes onboarding', async () => {
    env.selfHosted = false
    const { admin, org } = await setUp()
    await configure(admin, { organizationId: org.id, domains: ['acme.test'] })
    const cookie = await emailLink('new@acme.test')
    expect(await me(cookie)).toMatchObject({ onboarded: true, organizations: [expect.objectContaining({ id: org.id, role: 'member' })] })
    const outside = await emailLink('new@other.test')
    expect(await me(outside)).toMatchObject({ onboarded: false, organizations: [] })
  })
})
