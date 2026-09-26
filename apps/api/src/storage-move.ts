import { and, eq, isNotNull } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { putBlob } from './storage.js'

// Content published before object storage sits in Postgres columns (migration 0008 hashed it).
// This uploads it under those hashes and empties the columns, a batch at a time. It runs on every
// start and does nothing once everything has moved; running it again after a crash is safe.
const BATCH = 50

export async function moveContentToStorage(): Promise<number> {
  let moved = 0

  const v = schema.artifactVersions
  for (;;) {
    const rows = await db.select({ id: v.id, hash: v.htmlSha256, html: v.legacyHtml }).from(v).where(isNotNull(v.legacyHtml)).limit(BATCH)
    if (rows.length === 0) break
    for (const r of rows) {
      await putBlob(r.html!, r.hash)
      await db.update(v).set({ legacyHtml: null }).where(eq(v.id, r.id))
    }
    moved += rows.length
  }

  const f = schema.artifactFiles
  for (;;) {
    const rows = await db
      .select({ versionId: f.versionId, path: f.path, hash: f.sha256, content: f.legacyContent })
      .from(f)
      .where(isNotNull(f.legacyContent))
      .limit(BATCH)
    if (rows.length === 0) break
    for (const r of rows) {
      await putBlob(r.content!, r.hash)
      await db.update(f).set({ legacyContent: null }).where(and(eq(f.versionId, r.versionId), eq(f.path, r.path)))
    }
    moved += rows.length
  }

  const t = schema.artifactThumbnails
  for (;;) {
    const rows = await db.select({ versionId: t.versionId, hash: t.sha256, image: t.legacyImage }).from(t).where(isNotNull(t.legacyImage)).limit(BATCH)
    if (rows.length === 0) break
    for (const r of rows) {
      await putBlob(r.image!, r.hash!)
      await db.update(t).set({ legacyImage: null }).where(eq(t.versionId, r.versionId))
    }
    moved += rows.length
  }

  return moved
}
