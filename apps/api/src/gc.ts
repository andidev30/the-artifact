import { sql } from 'drizzle-orm'
import { db } from './db/index.js'
import { deleteBlobs, listBlobs } from './storage.js'

// Blobs are shared by every version that has the same content, so deleting a page or an account
// deletes rows only. This removes the blobs no row refers to any more.
//
// Writers (publish, restore, thumbnails) hold this lock shared from before they upload until their
// rows are committed; the sweep takes it exclusively while it decides and deletes. So a blob that is
// being reused as the sweep runs is either already referenced when it looks, or uploaded again after.
const LOCK = 7_331_001

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function holdStorageLock(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${LOCK})`)
}

// Also skips blobs written recently, e.g. by a publish that failed after uploading
const GRACE_MS = 60 * 60 * 1000
const EVERY_MS = 6 * 60 * 60 * 1000

export async function sweepStorage({ graceMs = GRACE_MS, now = Date.now() } = {}): Promise<{ checked: number; deleted: number }> {
  const candidates: string[] = []
  let checked = 0
  for await (const blob of listBlobs()) {
    checked += 1
    if (now - blob.lastModified.getTime() >= graceMs) candidates.push(blob.hash)
  }
  if (candidates.length === 0) return { checked, deleted: 0 }

  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`)
    const rows = await tx.execute<{ hash: string }>(sql`
      select html_sha256 as hash from artifact_versions
      union select sha256 from artifact_files
      union select sha256 from artifact_thumbnails where sha256 is not null`)
    const used = new Set([...rows].map((r) => r.hash))
    const unused = candidates.filter((h) => !used.has(h))
    await deleteBlobs(unused)
    return unused.length
  })
  return { checked, deleted }
}

// Runs in the background every few hours while the server is up
export function scheduleSweeps() {
  const run = () =>
    sweepStorage()
      .then(({ deleted }) => deleted && console.log(`Storage: removed ${deleted} unused blob${deleted === 1 ? '' : 's'}`))
      .catch((err) => console.error('Storage sweep failed:', err))
  setTimeout(run, 60_000).unref()
  setInterval(run, EVERY_MS).unref()
}
