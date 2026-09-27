import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountSuspendedError, canSignUp, findOrCreateUser } from '../../src/auth/users.js'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, mcpRequest, type TestUser } from './helpers.js'

const original = { selfHosted: env.selfHosted }

afterEach(() => {
  env.selfHosted = original.selfHosted
})

async function isAdminInDb(email: string) {
  const [row] = await db.select({ isAdmin: schema.users.isAdmin }).from(schema.users).where(eq(schema.users.email, email))
  return row?.isAdmin
}

async function me(user: TestUser) {
  const res = await call('/api/me', { cookie: user.cookie })
  return { status: res.status, body: (await res.json()) as { isAdmin?: boolean } }
}

describe('first account becomes the instance admin', () => {
  it('makes only the first account an admin when self-hosted', async () => {
    env.selfHosted = true
    await findOrCreateUser({ email: 'first@example.com' })
    await findOrCreateUser({ email: 'second@example.com' })
    expect(await isAdminInDb('first@example.com')).toBe(true)
    expect(await isAdminInDb('second@example.com')).toBe(false)
  })

  it('gives exactly one of many simultaneous sign-ups admin', async () => {
    env.selfHosted = true
    const emails = Array.from({ length: 8 }, (_, i) => `racer${i}@example.com`)
    const users = await Promise.all(emails.map((email) => findOrCreateUser({ email })))
    expect(users.filter((u) => u.isAdmin)).toHaveLength(1)
    const rows = await db.select().from(schema.users)
    expect(rows).toHaveLength(8)
    expect(rows.filter((r) => r.isAdmin)).toHaveLength(1)
  })

  it('creates one account when the same person signs up twice at once', async () => {
    env.selfHosted = true
    const [a, b] = await Promise.all([findOrCreateUser({ email: 'twice@example.com' }), findOrCreateUser({ email: 'twice@example.com' })])
    expect(a.id).toBe(b.id)
    expect(a.isAdmin).toBe(true)
  })

  it('does nothing on the hosted service', async () => {
    env.selfHosted = false
    const user = await findOrCreateUser({ email: 'cloud@example.com' })
    expect(user.isAdmin).toBe(false)
  })

  it('reports the flag on /api/me', async () => {
    const admin = await createUser({ admin: true })
    const other = await createUser()
    expect((await me(admin)).body.isAdmin).toBe(true)
    expect((await me(other)).body.isAdmin).toBe(false)
  })
})

describe('admin endpoints are for admins only', () => {
  const endpoints: [string, string, unknown?][] = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/users'],
    ['PATCH', '/api/admin/users/00000000-0000-0000-0000-000000000000', { admin: true }],
    ['GET', '/api/admin/users/00000000-0000-0000-0000-000000000000/deletion'],
    ['DELETE', '/api/admin/users/00000000-0000-0000-0000-000000000000', { confirmEmail: 'x@example.com' }],
    ['GET', '/api/admin/organizations'],
    ['DELETE', '/api/admin/organizations/00000000-0000-0000-0000-000000000000', { confirmSlug: 'acme' }],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', { signupPolicy: 'open' }],
    ['POST', '/api/admin/sign-up-links', { email: 'x@example.com' }],
  ]

  it.each(endpoints)('%s %s', async (method, path, json) => {
    const member = await createUser()
    expect((await call(path, { method, json })).status).toBe(401)
    const res = await call(path, { method, json, cookie: member.cookie })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'not_admin' })
  })

  it('stops working once the admin is demoted', async () => {
    const a = await createUser({ admin: true })
    const b = await createUser({ admin: true })
    expect((await call(`/api/admin/users/${a.id}`, { method: 'PATCH', cookie: b.cookie, json: { admin: false } })).status).toBe(200)
    expect((await call('/api/admin/overview', { cookie: a.cookie })).status).toBe(403)
  })
})

describe('users', () => {
  let admin: TestUser
  beforeEach(async () => {
    admin = await createUser({ email: 'admin@example.com', name: 'Ada Admin', admin: true })
  })

  it('lists people with their organizations, pages and status', async () => {
    const bob = await createUser({ email: 'bob@example.com', name: 'Bob' })
    const org = await createOrg(bob, 'Bobs', 'bobs')
    await createPage(bob)
    await createPage(bob, { organizationId: org.id })
    await connectAgent(bob)
    await call('/api/me', { cookie: bob.cookie })

    const res = await call('/api/admin/users', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; users: Record<string, unknown>[] }
    expect(body.total).toBe(2)
    const row = body.users.find((u) => u.email === 'bob@example.com')!
    expect(row).toMatchObject({
      name: 'Bob',
      isAdmin: false,
      suspended: false,
      pageCount: 2,
      organizations: [{ id: org.id, name: 'Bobs', role: 'owner' }],
      isYou: false,
    })
    expect(row.lastSeenAt).toBeTruthy()
    expect(body.users.find((u) => u.email === 'admin@example.com')).toMatchObject({ isAdmin: true, isYou: true })
  })

  it('searches by email and name, and filters', async () => {
    await createUser({ email: 'carol@corp.test', name: 'Carol Jones' })
    await createUser({ email: 'dan@example.com', name: 'Dan 100%' })
    const search = async (q: string) => {
      const res = await call(`/api/admin/users?${new URLSearchParams(q)}`, { cookie: admin.cookie })
      return ((await res.json()) as { users: { email: string }[] }).users.map((u) => u.email)
    }
    expect(await search('q=corp')).toEqual(['carol@corp.test'])
    expect(await search('q=jones')).toEqual(['carol@corp.test'])
    expect(await search('q=100%')).toEqual(['dan@example.com'])
    expect(await search('q=_')).toEqual([])
    expect(await search('filter=admins')).toEqual(['admin@example.com'])
  })

  it('promotes and demotes admins', async () => {
    const bob = await createUser()
    const up = await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', cookie: admin.cookie, json: { admin: true } })
    expect(up.status).toBe(200)
    expect(await up.json()).toMatchObject({ id: bob.id, isAdmin: true })
    expect((await call('/api/admin/overview', { cookie: bob.cookie })).status).toBe(200)
    const down = await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', cookie: admin.cookie, json: { admin: false } })
    expect(await down.json()).toMatchObject({ isAdmin: false })
  })

  it('won’t remove the last admin', async () => {
    const res = await call(`/api/admin/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, json: { admin: false } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'last_admin' })
    expect(await isAdminInDb(admin.email)).toBe(true)
  })

  it('won’t let two admins demote each other at the same moment', async () => {
    const other = await createUser({ admin: true })
    const results = await Promise.all([
      call(`/api/admin/users/${other.id}`, { method: 'PATCH', cookie: admin.cookie, json: { admin: false } }),
      call(`/api/admin/users/${admin.id}`, { method: 'PATCH', cookie: other.cookie, json: { admin: false } }),
    ])
    const rows = await db.select().from(schema.users).where(eq(schema.users.isAdmin, true))
    expect(rows).toHaveLength(1)
    const statuses = results.map((r) => r.status).sort()
    expect(statuses[0]).toBe(200)
    // Refused either as the last admin, or because the second admin had just lost access
    expect([403, 409]).toContain(statuses[1])
  })

  it('won’t let you delete your own account while you are the only admin', async () => {
    await createUser()
    const res = await call('/api/me', { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: admin.email } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'last_admin' })
  })

  it('lets the only person on the instance delete their account', async () => {
    const res = await call('/api/me', { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: admin.email } })
    expect(res.status).toBe(204)
  })

  it('returns 404 for unknown people', async () => {
    const res = await call('/api/admin/users/not-a-uuid', { method: 'PATCH', cookie: admin.cookie, json: { suspended: true } })
    expect(res.status).toBe(404)
  })
})

describe('suspension', () => {
  it('signs the person out, revokes agents and blocks signing in; pages stay', async () => {
    const admin = await createUser({ admin: true })
    const bob = await createUser({ email: 'bob@example.com' })
    const tokens = await connectAgent(bob)
    const page = await createPage(bob, { visibility: 'link' })
    expect((await callTool(tokens.access_token, 'list_artifacts', {})).isError).toBe(false)

    const res = await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', cookie: admin.cookie, json: { suspended: true } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ suspended: true })

    expect((await call('/api/me', { cookie: bob.cookie })).status).toBe(401)
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, bob.id))).toHaveLength(0)
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(401)
    const refresh = await call('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token } })
    expect(refresh.status).toBe(400)
    await expect(findOrCreateUser({ email: 'bob@example.com' })).rejects.toBeInstanceOf(AccountSuspendedError)
    // No sign-in link is sent to a suspended account
    const link = await call('/api/auth/email', { json: { email: 'BOB@example.com' } })
    expect(link.status).toBe(403)
    expect(await link.json()).toMatchObject({ code: 'account_suspended' })
    expect(sendSignInLink).not.toHaveBeenCalled()

    // The page is still there and still opens by link
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(200)

    const back = await call(`/api/admin/users/${bob.id}`, { method: 'PATCH', cookie: admin.cookie, json: { suspended: false } })
    expect(await back.json()).toMatchObject({ suspended: false })
    expect((await findOrCreateUser({ email: 'bob@example.com' })).id).toBe(bob.id)
  })

  it('blocks MCP calls even with a token issued before a manual suspension', async () => {
    const bob = await createUser()
    const tokens = await connectAgent(bob)
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, bob.id))
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(401)
  })

  it('won’t let you suspend yourself', async () => {
    const admin = await createUser({ admin: true })
    const res = await call(`/api/admin/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, json: { suspended: true } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'self' })
  })

  it('suspended admins lose admin access while suspended', async () => {
    const admin = await createUser({ admin: true })
    const other = await createUser({ admin: true })
    await call(`/api/admin/users/${other.id}`, { method: 'PATCH', cookie: admin.cookie, json: { suspended: true } })
    const overview = (await (await call('/api/admin/overview', { cookie: admin.cookie })).json()) as { admins: number; suspended: number }
    expect(overview).toMatchObject({ admins: 1, suspended: 1 })
  })
})

describe('deleting people', () => {
  it('follows the account deletion rules and needs their email typed', async () => {
    const admin = await createUser({ admin: true })
    const bob = await createUser({ email: 'bob@example.com' })
    const carol = await createUser({ email: 'carol@example.com' })
    const org = await createOrg(bob, 'Shared', 'shared')
    await addMember(org.id, carol, 'member')
    const solo = await createOrg(carol, 'Solo', 'solo')

    const preview = await call(`/api/admin/users/${bob.id}/deletion`, { cookie: admin.cookie })
    expect(await preview.json()).toMatchObject({ blockedBy: [{ id: org.id, name: 'Shared' }] })

    expect((await call(`/api/admin/users/${bob.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: 'nope' } })).status).toBe(400)
    const blocked = await call(`/api/admin/users/${bob.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: bob.email } })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: 'last_owner' })

    // Carol owns Solo alone, so it goes with her
    const del = await call(`/api/admin/users/${carol.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: carol.email } })
    expect(del.status).toBe(204)
    expect(await db.select().from(schema.users).where(eq(schema.users.id, carol.id))).toHaveLength(0)
    expect(await db.select().from(schema.organizations).where(eq(schema.organizations.id, solo.id))).toHaveLength(0)
  })

  it('won’t delete yourself from the admin area', async () => {
    const admin = await createUser({ admin: true })
    const res = await call(`/api/admin/users/${admin.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: admin.email } })
    expect(res.status).toBe(409)
  })

  it('can delete another admin', async () => {
    const admin = await createUser({ admin: true })
    const other = await createUser({ admin: true })
    const res = await call(`/api/admin/users/${other.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: other.email } })
    expect(res.status).toBe(204)
  })
})

describe('organizations', () => {
  it('lists organizations with counts and owners, and deletes them', async () => {
    const admin = await createUser({ admin: true })
    const bob = await createUser({ email: 'bob@example.com', name: 'Bob' })
    const carol = await createUser()
    const org = await createOrg(bob, 'Acme Inc', 'acme')
    await addMember(org.id, carol, 'member')
    await createPage(bob, { organizationId: org.id })

    const res = await call('/api/admin/organizations?q=acm', { cookie: admin.cookie })
    const body = (await res.json()) as { total: number; organizations: unknown[] }
    expect(body.total).toBe(1)
    expect(body.organizations[0]).toMatchObject({
      id: org.id,
      name: 'Acme Inc',
      slug: 'acme',
      memberCount: 2,
      pageCount: 1,
      owners: [{ id: bob.id, email: 'bob@example.com', name: 'Bob' }],
    })

    expect((await call(`/api/admin/organizations/${org.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmSlug: 'nope' } })).status).toBe(400)
    expect((await call(`/api/admin/organizations/${org.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmSlug: 'acme' } })).status).toBe(204)
    expect(await db.select().from(schema.organizations)).toHaveLength(0)
    expect(await db.select().from(schema.artifacts)).toHaveLength(0)
    expect(await db.select().from(schema.users)).toHaveLength(3)
  })
})

describe('sign-up policy', () => {
  let admin: TestUser
  beforeEach(async () => {
    admin = await createUser({ admin: true })
  })
  const put = (json: unknown) => call('/api/admin/settings', { method: 'PUT', cookie: admin.cookie, json })
  const request = (email: string) => call('/api/auth/email', { json: { email, intent: 'signup' } })

  async function invite(email: string) {
    const org = await createOrg(admin, 'Team', `team-${Math.random().toString(36).slice(2, 8)}`)
    await db.insert(schema.invitations).values({
      organizationId: org.id,
      email,
      role: 'member',
      tokenHash: hashToken(`invite-${email}`),
      expiresAt: new Date(Date.now() + 60_000),
    })
  }

  it('starts open until an admin saves it', async () => {
    const res = await call('/api/admin/settings', { cookie: admin.cookie })
    expect(await res.json()).toEqual({ signupPolicy: 'open', allowedDomains: [], instanceName: null, updatedAt: null })
    expect((await request('anyone@elsewhere.com')).status).toBe(204)
  })

  it('refuses a sign-in link opened after sign-ups were closed', async () => {
    expect((await request('late@elsewhere.com')).status).toBe(204)
    const link = new URL(vi.mocked(sendSignInLink).mock.calls[0][1])
    await put({ signupPolicy: 'domains', allowedDomains: ['example.com'] })
    const res = await call('/api/auth/email/confirm', { json: { token: link.searchParams.get('token') } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'signup_closed' })
  })

  it('domains accepts listed domains and invited people', async () => {
    const res = await put({ signupPolicy: 'domains', allowedDomains: ['Corp.test', '@other.test', 'corp.test'] })
    expect(await res.json()).toMatchObject({ signupPolicy: 'domains', allowedDomains: ['corp.test', 'other.test'] })
    expect((await request('a@corp.test')).status).toBe(204)
    expect((await request('b@other.test')).status).toBe(204)
    expect((await request('c@example.com')).status).toBe(403)
    await invite('c@example.com')
    expect((await request('c@example.com')).status).toBe(204)
  })

  it('invite-only accepts invited people and people a page was shared with', async () => {
    await put({ signupPolicy: 'invite-only' })
    expect((await request('stranger@example.com')).status).toBe(403)
    await invite('guest@example.com')
    expect((await request('guest@example.com')).status).toBe(204)
    const page = await createPage(admin)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: 'reader@example.com', role: 'viewer' })
    expect((await request('reader@example.com')).status).toBe(204)
    // Existing accounts still sign in
    expect((await request(admin.email)).status).toBe(204)
    await expect(findOrCreateUser({ email: 'stranger@example.com' })).rejects.toThrow()
  })

  it('validates the form', async () => {
    expect(await (await put({ signupPolicy: 'closed' })).json()).toMatchObject({ field: 'signupPolicy' })
    expect(await (await put({ signupPolicy: 'domains', allowedDomains: [] })).json()).toMatchObject({ field: 'allowedDomains' })
    expect(await (await put({ signupPolicy: 'domains', allowedDomains: ['not a domain'] })).json()).toMatchObject({ field: 'allowedDomains' })
    expect(await (await put({ signupPolicy: 'open', instanceName: 'x'.repeat(61) })).json()).toMatchObject({ field: 'instanceName' })
  })

  it('shows the instance name in /api/config', async () => {
    await put({ signupPolicy: 'invite-only', instanceName: '  Acme   pages ' })
    expect(await (await call('/api/config')).json()).toMatchObject({ instanceName: 'Acme pages' })
  })
})

describe('overview', () => {
  it('counts what is on the instance', async () => {
    const admin = await createUser({ admin: true })
    const bob = await createUser()
    await createOrg(bob, 'Bobs', 'bobs')
    await createPage(bob)
    await connectAgent(bob)
    const res = await call('/api/admin/overview', { cookie: admin.cookie })
    expect(await res.json()).toMatchObject({
      users: 2,
      admins: 1,
      suspended: 0,
      newThisWeek: 2,
      organizations: 1,
      pages: 1,
      peopleWithAgents: 1,
      signupPolicy: 'open',
    })
  })
})
