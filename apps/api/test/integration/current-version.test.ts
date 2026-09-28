import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { publish, recentAccessLevel } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { call, createPage, createUser, type TestUser } from './helpers.js'

// GET /api/artifacts/:slug/current, which an open page asks every few seconds to show new versions
async function republish(owner: TestUser, slug: string, html = '<!doctype html><h1>Again</h1>') {
  return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 'test-client', title: 'Test page', html, slug })
}

describe('the current version of a page', () => {
  it('answers the version number, and 304 while it is unchanged', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const res = await call(`/api/artifacts/${page.slug}/current`, { cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1 })
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')

    const same = await call(`/api/artifacts/${page.slug}/current`, { cookie: owner.cookie, headers: { 'if-none-match': '"v1"' } })
    expect(same.status).toBe(304)
    expect(await same.text()).toBe('')

    await republish(owner, page.slug)
    const newer = await call(`/api/artifacts/${page.slug}/current`, { cookie: owner.cookie, headers: { 'if-none-match': 'W/"v1"' } })
    expect(newer.status).toBe(200)
    expect(await newer.json()).toEqual({ version: 2 })
    expect(newer.headers.get('etag')).toBe('"v2"')
  })

  it('follows the same access rules as the page, and says 404 for missing and closed pages', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const page = await createPage(owner)
    expect((await call(`/api/artifacts/${page.slug}/current`)).status).toBe(404)
    const closed = await call(`/api/artifacts/${page.slug}/current`, { cookie: stranger.cookie })
    expect(closed.status).toBe(404)
    expect(closed.headers.get('etag')).toBeNull()
    expect((await call('/api/artifacts/nosuchpage1/current', { cookie: owner.cookie })).status).toBe(404)
    expect((await call('/api/artifacts/not%20a%20slug/current', { cookie: owner.cookie })).status).toBe(404)

    // General access is read fresh on every request
    await db.update(schema.artifacts).set({ visibility: 'link' }).where(eq(schema.artifacts.id, page.id))
    expect((await call(`/api/artifacts/${page.slug}/current`)).status).toBe(200)
    await db.update(schema.artifacts).set({ visibility: 'private' }).where(eq(schema.artifacts.id, page.id))
    expect((await call(`/api/artifacts/${page.slug}/current`)).status).toBe(404)

    await db.delete(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect((await call(`/api/artifacts/${page.slug}/current`, { cookie: owner.cookie })).status).toBe(404)
  })

  it('takes the link key of a page whose link was reset', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    await db.update(schema.artifacts).set({ linkToken: 'secretkey123' }).where(eq(schema.artifacts.id, page.id))
    expect((await call(`/api/artifacts/${page.slug}/current`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/current?k=wrong`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/current?k=secretkey123`)).status).toBe(200)
  })

  it('remembers what a person is to a page for a few seconds only', async () => {
    const owner = await createUser()
    const friend = await createUser()
    const page = await createPage(owner)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: friend.email, role: 'viewer' })
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    const viewer = { id: friend.id, email: friend.email, blockedOrgs: [] }
    const start = Date.now()
    expect(await recentAccessLevel(row, viewer, {}, start)).toBe('view')

    await db.delete(schema.artifactShares).where(eq(schema.artifactShares.artifactId, page.id))
    expect(await recentAccessLevel(row, viewer, {}, start + 5_000)).toBe('view')
    expect(await recentAccessLevel(row, viewer, {}, start + 10_000)).toBeNull()
    // A change to the page row itself counts at once
    expect(await recentAccessLevel({ ...row, visibility: 'link' }, viewer, {}, start + 10_001)).toBe('view')
  })
})
