import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { addMember, call, createOrg, createPage, createUser, type TestUser } from './helpers.js'

function deleteAccount(user: TestUser) {
  return call('/api/me', { method: 'DELETE', cookie: user.cookie, json: { confirmEmail: user.email } })
}

async function preview(user: TestUser) {
  const res = await call('/api/me/deletion', { cookie: user.cookie })
  expect(res.status).toBe(200)
  return res.json()
}

async function ownerOf(slug: string) {
  const [row] = await db.select({ ownerId: schema.artifacts.ownerId }).from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
  return row?.ownerId ?? null
}

describe('deleting an account', () => {
  it('needs the email typed exactly', async () => {
    const user = await createUser({ email: 'me@example.com' })
    const res = await call('/api/me', { method: 'DELETE', cookie: user.cookie, json: { confirmEmail: 'nope@example.com' } })
    expect(res.status).toBe(400)
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('moves pages in shared organizations to an owner, keeping versions, and deletes personal pages', async () => {
    const founder = await createUser({ email: 'founder@example.com', name: 'Fay Founder' })
    const org = await createOrg(founder, 'Acme', 'acme')
    const author = await createUser({ email: 'author@example.com' })
    await addMember(org.id, author, 'member')

    const orgPage = await createPage(author, { organizationId: org.id, visibility: 'organization', title: 'Team chart' })
    await publish({ userId: author.id, email: author.email, organizationId: org.id, clientName: 'test-client', title: 'Team chart', html: '<p>v2</p>', slug: orgPage.slug })
    const privateOrgPage = await createPage(author, { organizationId: org.id, visibility: 'private', title: 'Draft' })
    const personal = await createPage(author, { title: 'Mine' })

    expect(await preview(author)).toEqual({
      blockedBy: [],
      deletesOrganizations: [],
      pages: { deleted: 1, transferred: 2 },
      transfers: [{ organization: 'Acme', to: 'Fay Founder', pages: 2 }],
    })

    expect((await deleteAccount(author)).status).toBe(204)
    expect(await ownerOf(orgPage.slug)).toBe(founder.id)
    expect(await ownerOf(privateOrgPage.slug)).toBe(founder.id)
    expect(await ownerOf(personal.slug)).toBeNull()

    // History survives; the versions the deleted person published have no author any more
    const versions = await call(`/api/artifacts/${orgPage.slug}/versions`, { cookie: founder.cookie })
    expect(versions.status).toBe(200)
    const list = (await versions.json()) as { version: number; publishedBy: string | null }[]
    expect(list.map((v) => v.version).sort()).toEqual([1, 2])
    expect(list.every((v) => v.publishedBy === null)).toBe(true)

    // The new owner owns it fully
    const page = await (await call(`/api/artifacts/${orgPage.slug}`, { cookie: founder.cookie })).json()
    expect(page).toMatchObject({ isOwner: true, canEdit: true, owner: 'Fay Founder', version: 2 })
    const latest = await call(`/api/artifacts/${orgPage.slug}/v/2/`, { cookie: founder.cookie })
    expect(await latest.text()).toBe('<p>v2</p>')
  })

  it('prefers another owner over an admin who joined earlier', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder)
    const admin = await createUser({ email: 'admin@example.com' })
    await addMember(org.id, admin, 'admin')
    const coOwner = await createUser({ email: 'co@example.com' })
    await addMember(org.id, coOwner, 'owner')
    const page = await createPage(founder, { organizationId: org.id })

    expect((await preview(founder)).transfers).toEqual([{ organization: 'Acme Inc', to: 'co@example.com', pages: 1 }])
    expect((await deleteAccount(founder)).status).toBe(204)
    expect(await ownerOf(page.slug)).toBe(coOwner.id)
  })

  it('falls back to an admin when an organization somehow has no other owner', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder)
    const member = await createUser({ email: 'member@example.com' })
    await addMember(org.id, member, 'member')
    const admin = await createUser({ email: 'admin@example.com' })
    await addMember(org.id, admin, 'admin')
    const author = await createUser({ email: 'author@example.com' })
    await addMember(org.id, author, 'member')
    // Not reachable through the API, which always keeps an owner
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, founder.id))
    const page = await createPage(author, { organizationId: org.id })

    expect((await deleteAccount(author)).status).toBe(204)
    expect(await ownerOf(page.slug)).toBe(admin.id)
  })

  it('moves pages in an organization the person already left', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder)
    const author = await createUser({ email: 'author@example.com' })
    await addMember(org.id, author, 'member')
    const page = await createPage(author, { organizationId: org.id })
    expect((await call(`/api/organizations/${org.id}/members/${author.id}`, { method: 'DELETE', cookie: author.cookie })).status).toBe(204)

    expect((await preview(author)).pages).toEqual({ deleted: 0, transferred: 1 })
    expect((await deleteAccount(author)).status).toBe(204)
    expect(await ownerOf(page.slug)).toBe(founder.id)
  })

  it('is still blocked for the last owner of an organization with other people, and changes nothing', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder, 'Acme', 'acme')
    const member = await createUser({ email: 'member@example.com' })
    await addMember(org.id, member, 'admin')
    const page = await createPage(founder, { organizationId: org.id })

    expect((await preview(founder)).blockedBy).toEqual([{ id: org.id, name: 'Acme' }])
    const res = await deleteAccount(founder)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'last_owner', organizations: [{ id: org.id, name: 'Acme' }] })
    expect(await ownerOf(page.slug)).toBe(founder.id)
    expect(await db.select().from(schema.users).where(eq(schema.users.id, founder.id))).toHaveLength(1)
  })

  it('deletes organizations with nobody else in them, with their pages', async () => {
    const solo = await createUser({ email: 'solo@example.com' })
    const org = await createOrg(solo, 'Solo Co', 'solo')
    const page = await createPage(solo, { organizationId: org.id })

    expect(await preview(solo)).toMatchObject({ deletesOrganizations: ['Solo Co'], pages: { deleted: 1, transferred: 0 }, transfers: [] })
    expect((await deleteAccount(solo)).status).toBe(204)
    expect(await ownerOf(page.slug)).toBeNull()
    expect(await db.select().from(schema.organizations)).toHaveLength(0)
  })

  it('keeps invitations and shares the person sent working', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder, 'Acme', 'acme')
    const author = await createUser({ email: 'author@example.com', name: 'Ann Author' })
    await addMember(org.id, author, 'admin')
    const page = await createPage(author, { organizationId: org.id, visibility: 'private' })

    // Shared with an outsider, and with the person who will take the page over
    const shared = await call(`/api/artifacts/${page.slug}/sharing/people`, {
      cookie: author.cookie,
      json: { emails: 'reader@example.com, founder@example.com', role: 'viewer', notify: false },
    })
    expect(shared.status).toBe(200)
    // An invitation the deleted person sent
    const invited = await call(`/api/organizations/${org.id}/invitations`, { cookie: author.cookie, json: { email: 'newbie@example.com', role: 'member' } })
    expect(invited.status).toBe(201)

    expect((await deleteAccount(author)).status).toBe(204)

    // The outsider still sees the page; the new owner is no longer listed as a viewer
    const reader = await createUser({ email: 'reader@example.com' })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: reader.cookie })).status).toBe(200)
    const shares = await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, page.id))
    expect(shares.map((s) => [s.email, s.invitedBy])).toEqual([['reader@example.com', null]])
    const sharing = await (await call(`/api/artifacts/${page.slug}/sharing`, { cookie: founder.cookie })).json()
    expect(sharing.owner.email).toBe('founder@example.com')

    // The invitation lists without an inviter and can still be accepted
    const details = await (await call(`/api/organizations/${org.id}`, { cookie: founder.cookie })).json()
    expect(details.invitations).toMatchObject([{ email: 'newbie@example.com', invitedBy: null }])
    const newbie = await createUser({ email: 'newbie@example.com' })
    const [pending] = await (await call('/api/me/invitations', { cookie: newbie.cookie })).json()
    expect(pending).toMatchObject({ organization: { name: 'Acme' }, invitedBy: null })
    expect((await call(`/api/me/invitations/${pending.id}/accept`, { cookie: newbie.cookie, method: 'POST' })).status).toBe(200)
  })

  it('removes the person everywhere else', async () => {
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder)
    const author = await createUser({ email: 'author@example.com' })
    await addMember(org.id, author, 'member')
    const other = await createPage(founder, { organizationId: org.id })
    await db.insert(schema.artifactShares).values({ artifactId: other.id, email: author.email, role: 'editor' })

    const res = await deleteAccount(author)
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie().join()).toMatch(/session=;/)
    expect((await call('/api/me', { cookie: author.cookie })).status).toBe(401)
    expect(await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.email, author.email))).toHaveLength(0)
    expect(
      await db.select().from(schema.memberships).where(and(eq(schema.memberships.organizationId, org.id), eq(schema.memberships.userId, author.id))),
    ).toHaveLength(0)
  })

  it('an instance admin deleting someone moves their organization pages the same way', async () => {
    const admin = await createUser({ email: 'admin@example.com', admin: true })
    const founder = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(founder, 'Acme', 'acme')
    const author = await createUser({ email: 'author@example.com' })
    await addMember(org.id, author, 'member')
    const orgPage = await createPage(author, { organizationId: org.id, visibility: 'organization' })
    const personal = await createPage(author, { title: 'Mine' })

    const res = await call(`/api/admin/users/${author.id}`, { method: 'DELETE', cookie: admin.cookie, json: { confirmEmail: author.email } })
    expect(res.status).toBe(204)
    expect(await ownerOf(orgPage.slug)).toBe(founder.id)
    expect(await ownerOf(personal.slug)).toBeNull()
  })
})
