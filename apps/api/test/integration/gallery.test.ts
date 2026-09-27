import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { addMember, call, createOrg, createPage, createUser, type TestUser } from './helpers.js'

async function list(user: TestUser, workspace?: string) {
  const res = await call(`/api/artifacts${workspace ? `?workspace=${workspace}` : ''}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { slug: string; title: string; mine: boolean; owner: string; role?: string; version: number; visibility: string }[]
}

const titles = (rows: { title: string }[]) => rows.map((r) => r.title)

describe('gallery', () => {
  it('needs a session', async () => {
    expect((await call('/api/artifacts')).status).toBe(401)
  })

  it('personal workspace shows only your own personal pages, newest first', async () => {
    const me = await createUser({ name: 'Me' })
    const other = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    const older = await createPage(me, { title: 'Older' })
    await createPage(me, { title: 'Newer', visibility: 'link' })
    await createPage(me, { title: 'In org', organizationId: org.id })
    await createPage(other, { title: 'Not mine', visibility: 'link' })
    await db
      .update(schema.artifacts)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.artifacts.id, older.id))

    const rows = await list(me)
    expect(titles(rows)).toEqual(['Newer', 'Older'])
    expect(rows[0]).toMatchObject({ mine: true, owner: 'Me', version: 1, visibility: 'link' })
    expect(titles(await list(me, 'personal'))).toEqual(['Newer', 'Older'])
  })

  it("organization workspace shows shared pages and your own private ones, not others' private pages", async () => {
    const me = await createUser({ email: 'me@example.com' })
    const teammate = await createUser({ email: 'mate@example.com', name: 'Mate' })
    const org = await createOrg(me, 'Acme', 'acme')
    await addMember(org.id, teammate, 'member')

    await createPage(me, { title: 'My private', organizationId: org.id, visibility: 'private' })
    await createPage(teammate, { title: 'Team page', organizationId: org.id, visibility: 'organization' })
    await createPage(teammate, { title: 'Public page', organizationId: org.id, visibility: 'link' })
    await createPage(teammate, { title: 'Mate private', organizationId: org.id, visibility: 'private' })
    await createPage(teammate, { title: 'Mate personal', visibility: 'link' })

    const rows = await list(me, org.id)
    expect(titles(rows).sort()).toEqual(['My private', 'Public page', 'Team page'])
    expect(rows.find((r) => r.title === 'Team page')).toMatchObject({ mine: false, owner: 'Mate' })

    expect(titles(await list(teammate, org.id)).sort()).toEqual(['Mate private', 'Public page', 'Team page'])
  })

  it('hides organizations you are not in', async () => {
    const me = await createUser()
    const other = await createUser()
    const org = await createOrg(other, 'Other', 'other')
    await createPage(other, { organizationId: org.id, visibility: 'organization' })
    const res = await call(`/api/artifacts?workspace=${org.id}`, { cookie: me.cookie })
    expect(res.status).toBe(404)
  })

  it('shared tab lists pages shared with you and your role', async () => {
    const owner = await createUser({ email: 'owner@example.com', name: 'Olivia' })
    const me = await createUser({ email: 'me@example.com' })
    const page = await createPage(owner, { title: 'For me' })
    const other = await createPage(owner, { title: 'Not for me' })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'ME@example.com', role: 'editor', notify: false } })
    await call(`/api/artifacts/${other.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'else@example.com', notify: false } })

    const rows = await list(me, 'shared')
    expect(rows).toEqual([expect.objectContaining({ slug: page.slug, title: 'For me', owner: 'Olivia', mine: false, role: 'editor' })])
    // Sharing doesn't add pages to your own workspace
    expect(await list(me)).toEqual([])
    expect(await list(owner, 'shared')).toEqual([])
  })

  it('shared tab updates when access is removed', async () => {
    const owner = await createUser()
    const me = await createUser({ email: 'me@example.com' })
    const page = await createPage(owner)
    const base = `/api/artifacts/${page.slug}/sharing/people`
    await call(base, { cookie: owner.cookie, json: { emails: 'me@example.com', notify: false } })
    expect(await list(me, 'shared')).toHaveLength(1)
    await call(`${base}?email=me@example.com`, { method: 'DELETE', cookie: owner.cookie })
    expect(await list(me, 'shared')).toHaveLength(0)
  })
})
