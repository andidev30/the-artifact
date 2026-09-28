// Removes blobs from object storage that no page, file or thumbnail refers to any more, records of
// who opened a page that are past their retention, and data exports that expired. The server does
// this every few hours on its own; this runs it now.
//   pnpm --filter @the-artifact/api storage:sweep
//   docker compose exec app node dist/scripts/sweep-storage.js
import { db } from '../db/index.js'
import { sweepExports } from '../exports.js'
import { sweepStorage } from '../gc.js'
import { deleteOldViews, VIEWER_RETENTION_DAYS } from '../views.js'

const { checked, deleted, uploads } = await sweepStorage()
console.log(`Checked ${checked} blob${checked === 1 ? '' : 's'}, removed ${deleted}, and ${uploads} unpublished upload${uploads === 1 ? '' : 's'}`)
const views = await deleteOldViews()
console.log(`Deleted ${views} record${views === 1 ? '' : 's'} of who opened a page from more than ${VIEWER_RETENTION_DAYS} days ago`)
const exports = await sweepExports()
console.log(`Deleted ${exports} expired or unused data export${exports === 1 ? '' : 's'} and their files`)
await db.$client.end()
