import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { auditSettled } from '../../src/audit.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendInvitation, sendMemberAdded } from '../../src/mail.js'
import { enableEnterprise, removeTestSigningKeys } from './enterprise.js'
import { addMember, call, createOrg, createUser, type TestUser } from './helpers.js'

// Adding someone who already has an account on a self-hosted server, instead of inviting them
const original = { selfHosted: env.selfHosted }

beforeEach(() => {
  env.selfHosted = true
})

afterEach(async () => {
  await auditSettled()
  env.selfHosted = original.selfHosted
  removeTestSigningKeys()
})

const addedMock = vi.mocked(sendMemberAdded)
const inviteMock = vi.mocked(sendInvitation)

function invite(from: TestUser, orgId: string, email: string, role: 'admin' | 'member' = 'member') {
  return call(`/api/organizations/${orgId}/invitations`, { cookie: from.cookie, json: { email, role } })
}

async function membership(orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)))
  return row ?? null
}

type Notice = { organization: { id: string; name: string; slug: string }; role: string; addedBy: string | null; addedAt: string }

async function notices(user: TestUser) {
  const res = await call('/api/me/added', { cookie: user.cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as Notice[]
}

describe('adding an existing account', () => {
  it('adds an account whose address was checked with the chosen role, and emails it', async () => {
    const owner = await createUser({ email: 'owner@example.com', name: 'Olivia Owner' })
    const org = await createOrg(owner, 'Acme', 'acme')
    const alex = await createUser({ email: 'alex@example.com', name: 'Alex' })

    const res = await invite(owner, org.id, 'Alex@Example.com', 'admin')
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({
      added: true,
      emailed: true,
      member: { id: alex.id, email: 'alex@example.com', name: 'Alex', role: 'admin' },
    })
    expect(body.link).toBeUndefined()
    expect(body.organization.members.map((m: { email: string }) => m.email)).toEqual(['owner@example.com', 'alex@example.com'])
    expect(body.organization.invitations).toEqual([])

    expect(await membership(org.id, alex.id)).toMatchObject({ role: 'admin', addedBy: owner.id, addedNotice: true })
    expect(await db.select().from(schema.invitations)).toHaveLength(0)
    expect(inviteMock).not.toHaveBeenCalled()
    expect(addedMock).toHaveBeenCalledWith('alex@example.com', { from: 'Olivia Owner', organization: 'Acme', role: 'admin', link: 'http://localhost:5177/app' })

    // A member at once: the organization is theirs to open
    const me = await (await call('/api/me', { cookie: alex.cookie })).json()
    expect(me.organizations).toMatchObject([{ id: org.id, role: 'admin' }])
  })

  it('replaces an invitation that was waiting for them', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    expect((await invite(owner, org.id, 'alex@example.com')).status).toBe(201)
    expect(await db.select().from(schema.invitations)).toHaveLength(1)

    const alex = await createUser({ email: 'alex@example.com' })
    const res = await invite(owner, org.id, 'alex@example.com')
    expect(await res.json()).toMatchObject({ added: true })
    expect(await db.select().from(schema.invitations)).toHaveLength(0)
    expect(await (await call('/api/me/invitations', { cookie: alex.cookie })).json()).toEqual([])
  })

  it('records member.added by the person who added them', async () => {
    await enableEnterprise()
    const owner = await createUser()
    const org = await createOrg(owner)
    const alex = await createUser({ email: 'alex@example.com' })
    await invite(owner, org.id, 'alex@example.com')

    await auditSettled()
    const events = await db.select().from(schema.auditEvents)
    expect(events.map((e) => e.action)).toEqual(['member.added'])
    expect(events[0]).toMatchObject({
      organizationId: org.id,
      actorId: owner.id,
      actorEmail: owner.email,
      targetType: 'member',
      targetId: alex.id,
      targetLabel: 'alex@example.com',
      details: { role: 'member' },
    })
  })

  it('still adds them when the email fails', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const alex = await createUser({ email: 'alex@example.com' })
    addedMock.mockRejectedValueOnce(new Error('SMTP down'))

    const res = await invite(owner, org.id, 'alex@example.com')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ added: true, emailed: false })
    expect(await membership(org.id, alex.id)).toMatchObject({ role: 'member' })
  })

  it('invites accounts whose address nobody checked', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const typed = await createUser({ email: 'typed@example.com' })
    await db.update(schema.users).set({ emailUnverified: true }).where(eq(schema.users.id, typed.id))

    const res = await invite(owner, org.id, 'typed@example.com')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ added: false, emailed: true })
    expect(await membership(org.id, typed.id)).toBeNull()
    expect(await db.select().from(schema.invitations)).toHaveLength(1)
    expect(inviteMock).toHaveBeenCalledOnce()
    expect(addedMock).not.toHaveBeenCalled()
  })

  it('invites suspended accounts', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const away = await createUser({ email: 'away@example.com' })
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, away.id))

    expect(await (await invite(owner, org.id, 'away@example.com')).json()).toMatchObject({ added: false })
    expect(await membership(org.id, away.id)).toBeNull()
    expect(await db.select().from(schema.invitations)).toHaveLength(1)
  })

  it('invites addresses without an account', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    expect(await (await invite(owner, org.id, 'new@example.com')).json()).toMatchObject({ added: false, emailed: true })
    expect(await db.select().from(schema.invitations)).toHaveLength(1)
  })

  it('always invites on the hosted service', async () => {
    env.selfHosted = false
    const owner = await createUser()
    const org = await createOrg(owner)
    const alex = await createUser({ email: 'alex@example.com' })

    expect(await (await invite(owner, org.id, 'alex@example.com')).json()).toMatchObject({ added: false, emailed: true })
    expect(await membership(org.id, alex.id)).toBeNull()
    expect(await db.select().from(schema.invitations)).toHaveLength(1)
    expect(await notices(alex)).toEqual([])
  })

  it('answers 409 for someone already in the organization', async () => {
    const owner = await createUser()
    const org = await createOrg(owner, 'Acme', 'acme')
    const alex = await createUser({ email: 'alex@example.com' })
    await addMember(org.id, alex, 'member')

    const res = await invite(owner, org.id, 'alex@example.com', 'admin')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'alex@example.com is already in Acme.', field: 'email' })
    expect(await membership(org.id, alex.id)).toMatchObject({ role: 'member', addedBy: null, addedNotice: false })
  })

  it('is for owners and admins only, and says nothing to anyone else', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const member = await createUser()
    await addMember(org.id, member, 'member')
    const outsider = await createUser()
    const alex = await createUser({ email: 'alex@example.com' })

    const byMember = await invite(member, org.id, 'alex@example.com')
    expect(byMember.status).toBe(403)
    expect(await byMember.json()).toEqual({ error: 'Only owners and admins can invite people.' })
    expect((await invite(outsider, org.id, 'alex@example.com')).status).toBe(404)
    expect(await membership(org.id, alex.id)).toBeNull()
  })

  it('lets an admin add people', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const admin = await createUser({ name: 'Ada Admin' })
    await addMember(org.id, admin, 'admin')
    const alex = await createUser({ email: 'alex@example.com' })

    expect(await (await invite(admin, org.id, 'alex@example.com')).json()).toMatchObject({ added: true })
    expect(await notices(alex)).toMatchObject([{ addedBy: 'Ada Admin' }])
  })
})

describe('the notice for people who were added', () => {
  it('needs a session', async () => {
    expect((await call('/api/me/added')).status).toBe(401)
    expect((await call('/api/me/added/00000000-0000-0000-0000-000000000000/dismiss', { method: 'POST' })).status).toBe(401)
  })

  it('shows who added you to which organization until you dismiss it', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner, 'Acme', 'acme')
    const alex = await createUser({ email: 'alex@example.com' })
    const other = await createUser()
    await invite(owner, org.id, 'alex@example.com', 'admin')

    const [notice] = await notices(alex)
    expect(notice).toMatchObject({ organization: { id: org.id, name: 'Acme', slug: 'acme' }, role: 'admin', addedBy: 'owner@example.com' })
    expect(await notices(other)).toEqual([])
    expect(await notices(owner)).toEqual([])

    // Someone else can't dismiss it for them
    expect((await call(`/api/me/added/${org.id}/dismiss`, { method: 'POST', cookie: other.cookie })).status).toBe(404)
    expect(await notices(alex)).toHaveLength(1)

    expect((await call(`/api/me/added/${org.id}/dismiss`, { method: 'POST', cookie: alex.cookie })).status).toBe(204)
    expect(await notices(alex)).toEqual([])
    // Dismissing leaves the membership alone
    expect(await membership(org.id, alex.id)).toMatchObject({ role: 'admin', addedNotice: false })
    expect((await call('/api/me/added/not-a-uuid/dismiss', { method: 'POST', cookie: alex.cookie })).status).toBe(404)
  })

  it('goes away when they leave', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const alex = await createUser({ email: 'alex@example.com' })
    await invite(owner, org.id, 'alex@example.com')

    expect((await call(`/api/organizations/${org.id}/members/${alex.id}`, { method: 'DELETE', cookie: alex.cookie })).status).toBe(204)
    expect(await notices(alex)).toEqual([])
    expect(await membership(org.id, alex.id)).toBeNull()
  })

  it('still shows when the person who added them deleted their account', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const admin = await createUser()
    await addMember(org.id, admin, 'admin')
    const alex = await createUser({ email: 'alex@example.com' })
    await invite(admin, org.id, 'alex@example.com')
    await db.delete(schema.users).where(eq(schema.users.id, admin.id))

    expect(await notices(alex)).toMatchObject([{ organization: { id: org.id }, addedBy: null }])
  })
})
