import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { addMember, call, createOrg, createPage, createUser } from './helpers.js'

describe('onboarding', () => {
  it('personal workspace marks the person onboarded', async () => {
    const user = await createUser({ onboarded: false })
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).onboarded).toBe(false)
    expect((await call('/api/onboarding/personal', { method: 'POST', cookie: user.cookie })).status).toBe(204)
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).onboarded).toBe(true)
  })

  it('needs a session', async () => {
    expect((await call('/api/onboarding/personal', { method: 'POST' })).status).toBe(401)
    expect((await call('/api/organizations', { json: { name: 'Acme', slug: 'acme' } })).status).toBe(401)
    expect((await call('/api/organizations/slug-available?slug=acme')).status).toBe(401)
  })
})

// Creating organizations is open on a self-hosted install only; the hosted service waits for billing
describe('creating organizations on a self-hosted install', () => {
  const original = env.selfHosted
  beforeEach(() => {
    env.selfHosted = true
  })
  afterEach(() => {
    env.selfHosted = original
  })

  it('is open, and the web app is told so', async () => {
    expect(await (await call('/api/config')).json()).toMatchObject({ newOrganizations: true })
  })

  it('creating one makes you its owner and finishes onboarding', async () => {
    const user = await createUser({ onboarded: false })
    const res = await call('/api/organizations', { cookie: user.cookie, json: { name: '  Acme Inc  ', slug: ' ACME ' } })
    expect(res.status).toBe(201)
    const org = await res.json()
    expect(org).toMatchObject({ name: 'Acme Inc', slug: 'acme', role: 'owner' })

    const me = await (await call('/api/me', { cookie: user.cookie })).json()
    expect(me.onboarded).toBe(true)
    expect(me.organizations).toEqual([{ id: org.id, name: 'Acme Inc', slug: 'acme', role: 'owner', requireTwoFactor: false, blocked: false }])
  })

  it('checks slug availability', async () => {
    const user = await createUser()
    const check = async (slug: string) => (await call(`/api/organizations/slug-available?slug=${encodeURIComponent(slug)}`, { cookie: user.cookie })).json()

    expect(await check('acme')).toEqual({ available: true })
    expect(await check('ab')).toMatchObject({ available: false, reason: expect.stringMatching(/3 to 40/) })
    expect(await check('login')).toMatchObject({ available: false, reason: expect.stringMatching(/reserved/) })

    await createOrg(user, 'Acme', 'acme')
    expect(await check('acme')).toMatchObject({ available: false, reason: expect.stringMatching(/already uses/) })
    expect(await check('ACME')).toMatchObject({ available: false })
  })

  it('rejects a slug another organization uses', async () => {
    const first = await createUser()
    const second = await createUser()
    expect((await call('/api/organizations', { cookie: first.cookie, json: { name: 'Acme', slug: 'acme' } })).status).toBe(201)
    const res = await call('/api/organizations', { cookie: second.cookie, json: { name: 'Other Acme', slug: 'acme' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ field: 'slug' })
    // Nothing half-created
    expect(await db.select().from(schema.organizations)).toHaveLength(1)
    expect(await db.select().from(schema.memberships)).toHaveLength(1)
  })

  it.each([
    [{ name: 'A', slug: 'acme' }, 'name'],
    [{ name: 'x'.repeat(61), slug: 'acme' }, 'name'],
    [{ slug: 'acme' }, 'name'],
    [{ name: 'Acme', slug: 'a' }, 'slug'],
    [{ name: 'Acme', slug: 'admin' }, 'slug'],
    [{ name: 'Acme', slug: 'acme_inc' }, 'slug'],
    [{ name: 'Acme' }, 'slug'],
  ])('validates %o', async (body, field) => {
    const user = await createUser()
    const res = await call('/api/organizations', { cookie: user.cookie, json: body })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field })
  })
})

describe('organizations on the hosted service', () => {
  it('refuses to create new ones, with a reason people can read', async () => {
    const user = await createUser({ onboarded: false })
    const res = await call('/api/organizations', { cookie: user.cookie, json: { name: 'Acme Inc', slug: 'acme' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: expect.stringMatching(/^New organizations are coming soon\./) })
    expect(await db.select().from(schema.organizations)).toHaveLength(0)
    expect(await db.select().from(schema.memberships)).toHaveLength(0)
    // Refusing doesn't finish onboarding
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).onboarded).toBe(false)
    expect(await (await call('/api/config')).json()).toMatchObject({ newOrganizations: false })
  })

  it('keeps existing ones working: members, invitations, pages and sharing', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner, 'Acme', 'acme')
    const member = await createUser({ email: 'member@example.com' })
    await addMember(org.id, member, 'member')

    // Invite someone new, who accepts from inside the app
    const guest = await createUser({ email: 'guest@example.com', onboarded: false })
    expect((await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: guest.email, role: 'member' } })).status).toBe(201)
    const [invitation] = await (await call('/api/me/invitations', { cookie: guest.cookie })).json()
    const accepted = await call(`/api/me/invitations/${invitation.id}/accept`, { cookie: guest.cookie, method: 'POST' })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ id: org.id, role: 'member' })

    // Pages published to the organization open for its members, and sharing still works
    const page = await createPage(owner, { organizationId: org.id, visibility: 'organization', title: 'Roadmap' })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: guest.cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: member.cookie })).status).toBe(200)
    const outsider = await createUser({ email: 'outsider@example.com' })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: outsider.cookie })).status).toBe(404)
    const shared = await call(`/api/artifacts/${page.slug}/sharing/people`, {
      cookie: owner.cookie,
      json: { emails: [outsider.email], role: 'viewer', notify: false },
    })
    expect(shared.status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: outsider.cookie })).status).toBe(200)
  })
})
