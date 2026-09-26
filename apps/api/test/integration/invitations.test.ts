import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { sendInvitation } from '../../src/mail.js'
import { addMember, call, createOrg, createUser, type TestUser } from './helpers.js'

const inviteMock = vi.mocked(sendInvitation)

async function invite(from: TestUser, orgId: string, email: string, role: 'admin' | 'member' = 'member') {
  const res = await call(`/api/organizations/${orgId}/invitations`, { cookie: from.cookie, json: { email, role } })
  expect(res.status).toBe(201)
  const [id] = (await db.select({ id: schema.invitations.id }).from(schema.invitations).where(and(eq(schema.invitations.email, email.toLowerCase()), eq(schema.invitations.organizationId, orgId))))
  return id.id
}

type Pending = { id: string; organization: { id: string; name: string; slug: string }; role: string; invitedBy: string | null; expiresAt: string }

async function pending(user: TestUser) {
  const res = await call('/api/me/invitations', { cookie: user.cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as Pending[]
}

describe('pending invitations inside the app', () => {
  it('needs a session', async () => {
    expect((await call('/api/me/invitations')).status).toBe(401)
    expect((await call('/api/me/invitations/00000000-0000-0000-0000-000000000000/accept', { method: 'POST' })).status).toBe(401)
  })

  it('lists unexpired invitations for your email, with the organization, role and inviter', async () => {
    const owner = await createUser({ email: 'owner@example.com', name: 'Olivia Owner' })
    const acme = await createOrg(owner, 'Acme', 'acme')
    const beta = await createOrg(owner, 'Beta', 'beta')
    const gamma = await createOrg(owner, 'Gamma', 'gamma')
    const guest = await createUser({ email: 'guest@example.com' })
    const acmeInvite = await invite(owner, acme.id, 'Guest@Example.com', 'admin')
    await invite(owner, beta.id, 'guest@example.com')
    const gammaInvite = await invite(owner, gamma.id, 'guest@example.com')
    await invite(owner, acme.id, 'someone-else@example.com')
    await db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitations.id, gammaInvite))
    expect(inviteMock).toHaveBeenCalledTimes(4)

    const list = await pending(guest)
    expect(list.map((i) => i.organization.name)).toEqual(['Acme', 'Beta'])
    expect(list[0]).toMatchObject({
      id: acmeInvite,
      organization: { id: acme.id, name: 'Acme', slug: 'acme' },
      role: 'admin',
      invitedBy: 'Olivia Owner',
    })
    // The token is never part of the listing
    expect(JSON.stringify(list)).not.toMatch(/token/i)
  })

  it('leaves out organizations you already joined another way', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    const guest = await createUser({ email: 'guest@example.com' })
    await invite(owner, org.id, 'guest@example.com')
    await addMember(org.id, guest, 'member')
    expect(await pending(guest)).toEqual([])
  })

  it('accepting by id joins with the invited role and removes the invitation', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner, 'Acme', 'acme')
    const guest = await createUser({ email: 'guest@example.com', onboarded: false })
    const id = await invite(owner, org.id, 'guest@example.com', 'admin')

    const res = await call(`/api/me/invitations/${id}/accept`, { cookie: guest.cookie, method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: org.id, name: 'Acme', slug: 'acme', role: 'admin' })

    const me = await (await call('/api/me', { cookie: guest.cookie })).json()
    expect(me.organizations).toEqual([{ id: org.id, name: 'Acme', slug: 'acme', role: 'admin' }])
    // Joining a team finishes onboarding
    expect(me.onboarded).toBe(true)
    expect(await pending(guest)).toEqual([])
    expect(await db.select().from(schema.invitations)).toHaveLength(0)

    // It can't be used twice
    expect((await call(`/api/me/invitations/${id}/accept`, { cookie: guest.cookie, method: 'POST' })).status).toBe(404)
  })

  it('declining by id removes the invitation without joining', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    const guest = await createUser({ email: 'guest@example.com' })
    const id = await invite(owner, org.id, 'guest@example.com')

    const res = await call(`/api/me/invitations/${id}/decline`, { cookie: guest.cookie, method: 'POST' })
    expect(res.status).toBe(204)
    expect(await pending(guest)).toEqual([])
    expect(await db.select().from(schema.invitations)).toHaveLength(0)
    const me = await (await call('/api/me', { cookie: guest.cookie })).json()
    expect(me.organizations).toEqual([])
  })

  it('invitations for another email look missing and stay untouched', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    const intruder = await createUser({ email: 'intruder@example.com' })
    const id = await invite(owner, org.id, 'guest@example.com')

    for (const action of ['accept', 'decline']) {
      const res = await call(`/api/me/invitations/${id}/${action}`, { cookie: intruder.cookie, method: 'POST' })
      expect(res.status).toBe(404)
    }
    expect(await db.select().from(schema.invitations)).toHaveLength(1)
    const [membership] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, intruder.id))
    expect(membership).toBeUndefined()
    // Nor can an invitation be found with a made-up id
    expect((await call('/api/me/invitations/not-a-uuid/accept', { cookie: intruder.cookie, method: 'POST' })).status).toBe(404)
  })

  it('refuses an expired invitation', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    const guest = await createUser({ email: 'guest@example.com' })
    const id = await invite(owner, org.id, 'guest@example.com')
    await db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1000) })

    const res = await call(`/api/me/invitations/${id}/accept`, { cookie: guest.cookie, method: 'POST' })
    expect(res.status).toBe(410)
    const me = await (await call('/api/me', { cookie: guest.cookie })).json()
    expect(me.organizations).toEqual([])
  })

  it('keeps the role of someone who joined before accepting', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    const guest = await createUser({ email: 'guest@example.com' })
    const id = await invite(owner, org.id, 'guest@example.com', 'member')
    await addMember(org.id, guest, 'admin')

    const res = await call(`/api/me/invitations/${id}/accept`, { cookie: guest.cookie, method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('admin')
  })
})
