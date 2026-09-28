import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { signContentLink } from '../../src/content.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { PERSONAL_HISTORY_DAYS, pruneHistory } from '../../src/ee/plans.js'
import { call, createUser, type TestUser } from './helpers.js'

// A version's files are cached in memory once read (src/artifacts.ts); the page row and the version row
// are read on every request. These check that every change to who may open a page, and every deleted
// version or page, applies to the very next request for a file that is already cached.

const HTML = '<!doctype html><link rel="stylesheet" href="site.css"><h1>Cached</h1>'

function site(owner: TestUser, opts: { visibility?: 'private' | 'link'; slug?: string } = {}) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId: null,
    clientName: 'test-client',
    title: 'Cached',
    html: HTML,
    files: [{ path: 'site.css', content: `body { color: red } /* ${crypto.randomUUID()} */` }],
    visibility: opts.visibility,
    slug: opts.slug,
  })
}

const file = (page: Artifact, version = page.currentVersion, opts: Parameters<typeof call>[1] = {}) =>
  call(`/api/artifacts/${page.slug}/v/${version}/site.css`, opts)

function patch(page: Artifact, owner: TestUser, json: Record<string, unknown>) {
  return call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: owner.cookie, json })
}

async function versionIdOf(page: Artifact, version: number) {
  const [row] = await db
    .select({ id: schema.artifactVersions.id })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, page.id), eq(schema.artifactVersions.version, version)))
  return row.id
}

describe('cached page files', () => {
  it('serves a version’s files from memory once read', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    // Files never change once written, so the rows aren't read again
    await db.delete(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, await versionIdOf(page, 1)))
    const res = await file(page)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('color: red')
    // A path the version doesn't have is still missing
    expect((await call(`/api/artifacts/${page.slug}/v/1/other.css`)).status).toBe(404)
  })

  it('stops serving them as soon as the page stops being shared by link', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    expect((await patch(page, owner, { visibility: 'private' })).status).toBe(200)
    expect((await file(page)).status).toBe(404)
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(200)
    expect((await patch(page, owner, { visibility: 'link' })).status).toBe(200)
    expect((await file(page)).status).toBe(200)
  })

  it('stops serving them under the old link as soon as the link is reset', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    const res = await patch(page, owner, { rotateLink: true })
    const key = new URL((await res.json()).link.url).searchParams.get('k')!
    expect((await file(page)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/v/1/site.css?k=${encodeURIComponent(key)}`)).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}/v/1/site.css?k=wrong`)).status).toBe(404)
  })

  it('stops serving them as soon as the link expires', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    await db
      .update(schema.artifacts)
      .set({ linkExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.artifacts.id, page.id))
    expect((await file(page)).status).toBe(404)
  })

  it('stops serving them to someone as soon as their access is removed', async () => {
    const owner = await createUser()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const page = await site(owner)
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: [viewer.email], notify: false } })
    const token = await signContentLink(viewer.id, page, 1)
    const path = `/api/artifacts/${page.slug}/v/1/~${token}/site.css`
    expect((await call(path)).status).toBe(200)
    const removed = await call(`/api/artifacts/${page.slug}/sharing/people?email=${encodeURIComponent(viewer.email)}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    })
    expect(removed.status).toBe(200)
    expect((await call(path)).status).toBe(404)
  })

  it('stops serving an older version to people who lose edit access when it is replaced', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page, 1)).status).toBe(200)
    await site(owner, { slug: page.slug })
    // Older versions are for editors only
    expect((await file(page, 1)).status).toBe(404)
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(200)
    expect((await file(page, 2)).status).toBe(200)
  })

  it('stops serving a deleted page', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}/v/1/`)).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect((await file(page)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/v/1/`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download`)).status).toBe(404)
  })

  it('stops serving a version the history pruning deleted', async () => {
    const owner = await createUser()
    const page = await site(owner)
    await site(owner, { slug: page.slug })
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(200)
    await db
      .update(schema.artifactVersions)
      .set({ createdAt: new Date(Date.now() - (PERSONAL_HISTORY_DAYS + 1) * 86_400_000) })
      .where(eq(schema.artifactVersions.id, await versionIdOf(page, 1)))
    expect(await pruneHistory()).toBe(1)
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download?version=1`, { cookie: owner.cookie })).status).toBe(404)
    expect((await file(page, 2, { cookie: owner.cookie })).status).toBe(200)
  })

  it('stops serving a version deleted by another server process', async () => {
    const owner = await createUser()
    const page = await site(owner)
    await site(owner, { slug: page.slug })
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}/download?version=1`, { cookie: owner.cookie })).status).toBe(200)
    // Straight in the database, as retention on another process would: this process's cache never hears of it
    await db.delete(schema.artifactVersions).where(eq(schema.artifactVersions.id, await versionIdOf(page, 1)))
    expect((await file(page, 1, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download?version=1`, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/1`, { cookie: owner.cookie })).status).toBe(404)
  })

  it('stops serving a page deleted by another server process', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    expect((await file(page)).status).toBe(200)
    await db.delete(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect((await file(page)).status).toBe(404)
  })
})
