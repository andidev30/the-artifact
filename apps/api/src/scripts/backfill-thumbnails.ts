// Renders thumbnails for the current version of every page that has none yet.
// The gallery also does this on demand, a page at a time; this does all of them at once.
//   pnpm --filter @the-artifact/api thumbnails:backfill [--retry-failed]
//   docker compose exec app node dist/scripts/backfill-thumbnails.js [--retry-failed]
import { and, eq, isNull, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
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
  .where(retryFailed ? or(isNull(t.versionId), isNull(t.image)) : isNull(t.versionId))

console.log(`${rows.length} page${rows.length === 1 ? '' : 's'} to render`)
let failed = 0
for (const [i, row] of rows.entries()) {
  const result = await renderThumbnail(row.versionId)
  if (result === 'failed') failed += 1
  console.log(`${i + 1}/${rows.length} ${row.slug}: ${result}`)
}
await closeThumbnailBrowser()
await db.$client.end()
console.log(failed ? `Done, ${failed} failed (run again with --retry-failed to retry them)` : 'Done')
