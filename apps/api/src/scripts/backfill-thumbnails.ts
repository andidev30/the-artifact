// Renders thumbnails for the current version of every page that has none yet.
// The gallery also does this on demand, a page at a time; this does all of them at once.
//   pnpm --filter @the-artifact/api thumbnails:backfill [--retry-failed]
//   docker compose exec app node dist/scripts/backfill-thumbnails.js [--retry-failed]
import { and, eq, isNull, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { closeThumbnailBrowser, renderThumbnail, thumbnailsEnabled } from '../thumbnails.js'

const retryFailed = process.argv.includes('--retry-failed')

if (!thumbnailsEnabled()) {
  console.error('Set CHROME_PATH to a Chrome or Chromium binary to render thumbnails.')
  process.exit(1)
}

const v = schema.artifactVersions
const t = schema.artifactThumbnails
const rows = await db
  .select({ versionId: v.id, slug: schema.artifacts.slug })
  .from(schema.artifacts)
  .innerJoin(v, and(eq(v.artifactId, schema.artifacts.id), eq(v.version, schema.artifacts.currentVersion)))
  .leftJoin(t, eq(t.versionId, v.id))
  .where(retryFailed ? or(isNull(t.versionId), isNull(t.sha256)) : isNull(t.versionId))

console.log(`${rows.length} page${rows.length === 1 ? '' : 's'} to render`)
let failed = 0
let done = 0
// THUMBNAIL_CONCURRENCY at a time, like the server's queue; the workers share one list
const next = rows.values()
async function worker() {
  for (const row of next) {
    const result = await renderThumbnail(row.versionId)
    if (result === 'failed') failed += 1
    done += 1
    console.log(`${done}/${rows.length} ${row.slug}: ${result}`)
  }
}
await Promise.all(Array.from({ length: env.thumbnails.concurrency }, worker))
await closeThumbnailBrowser()
await db.$client.end()
console.log(failed ? `Done, ${failed} failed (run again with --retry-failed to retry them)` : 'Done')
