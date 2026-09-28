import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { sha256 } from '../../src/files.js'
import { sweepStorage } from '../../src/gc.js'
import { getBlob, listBlobs, putBlob } from '../../src/storage.js'
import { call, createPage, createUser, type TestUser } from './helpers.js'

// Unique per run: the test bucket keeps blobs between runs, and the sweep only removes old ones
const unique = () => `<!doctype html><p>${crypto.randomUUID()}</p>`

async function stored() {
  const hashes = new Set<string>()
  for await (const b of listBlobs()) hashes.add(b.hash)
  return hashes
}

function republish(owner: TestUser, slug: string, html: string, files?: { path: string; content: string }[]) {
  return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 'test', title: 'Page', html, files, slug })
}

describe('object storage', () => {
  it('keeps content in the bucket under its hash, and only hashes in the database', async () => {
    const owner = await createUser()
    const html = unique()
    const page = await createPage(owner, { html })
    const [v] = await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, page.id))
    expect(v).toMatchObject({ htmlSha256: sha256(html), htmlSize: Buffer.byteLength(html) })
    expect((await getBlob(v.htmlSha256))?.toString()).toBe(html)
    expect(await (await call(`/api/artifacts/${page.slug}/v/1/`, { cookie: owner.cookie })).text()).toBe(html)
  })

  it('stores content shared by versions once, and restoring stores nothing new', async () => {
    const owner = await createUser()
    const css = `p { color: #${crypto.randomUUID().slice(0, 6)} }`
    const page = await createPage(owner)
    await republish(owner, page.slug, unique(), [{ path: 'site.css', content: css }])
    await republish(owner, page.slug, unique(), [{ path: 'site.css', content: css }])
    const before = await stored()

    const res = await call(`/api/artifacts/${page.slug}/versions/2/restore`, { method: 'POST', cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect(await stored()).toEqual(before)
    const files = await db.select().from(schema.artifactFiles)
    expect(files).toHaveLength(3)
    expect(new Set(files.map((f) => f.sha256))).toEqual(new Set([sha256(css)]))
    expect(await (await call(`/api/artifacts/${page.slug}/v/4/site.css`, { cookie: owner.cookie })).text()).toBe(css)
  })

  it('the sweep removes blobs of deleted pages and keeps the ones still in use', async () => {
    const owner = await createUser()
    const kept = unique()
    const gone = unique()
    const shared = `/* ${crypto.randomUUID()} */`
    await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: null,
      clientName: 'test',
      title: 'Kept',
      html: kept,
      files: [{ path: 'a.css', content: shared }],
    })
    const doomed = await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: null,
      clientName: 'test',
      title: 'Gone',
      html: gone,
      files: [{ path: 'a.css', content: shared }],
    })

    expect((await call(`/api/artifacts/${doomed.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    // Recent blobs are left alone, in case a publish is still on its way to committing them
    await sweepStorage()
    expect(await getBlob(sha256(gone))).not.toBeNull()

    await sweepStorage({ graceMs: 0 })
    expect(await getBlob(sha256(gone))).toBeNull()
    expect((await getBlob(sha256(kept)))?.toString()).toBe(kept)
    expect((await getBlob(sha256(shared)))?.toString()).toBe(shared)
  })

  it('reaches every blob when a sweep with a deadline starts listing at a random hash', async () => {
    const owner = await createUser()
    const kept = unique()
    await createPage(owner, { html: kept })
    const loose = await Promise.all(Array.from({ length: 6 }, () => putBlob(unique())))

    expect(await sweepStorage({ graceMs: 0, deadline: Date.now() - 1 })).toEqual({ checked: 0, deleted: 0, uploads: 0 })
    for (const hash of loose) expect(await getBlob(hash)).not.toBeNull()

    const { checked, deleted } = await sweepStorage({ graceMs: 0, deadline: Date.now() + 60_000 })
    expect(checked).toBeGreaterThanOrEqual(loose.length + 1)
    expect(deleted).toBeGreaterThanOrEqual(loose.length)
    for (const hash of loose) expect(await getBlob(hash)).toBeNull()
    expect((await getBlob(sha256(kept)))?.toString()).toBe(kept)
  })

  it('writes the same content to the same key', async () => {
    const content = crypto.randomUUID()
    expect(await putBlob(content)).toBe(sha256(content))
    expect(await putBlob(Buffer.from(content))).toBe(sha256(content))
  })
})
