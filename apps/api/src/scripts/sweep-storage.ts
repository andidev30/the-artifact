// Removes blobs from object storage that no page, file or thumbnail refers to any more.
// The server does this every few hours on its own; this runs it now.
//   pnpm --filter @the-artifact/api storage:sweep
//   docker compose exec app node dist/scripts/sweep-storage.js
import { db } from '../db/index.js'
import { sweepStorage } from '../gc.js'

const { checked, deleted, uploads } = await sweepStorage()
console.log(`Checked ${checked} blob${checked === 1 ? '' : 's'}, removed ${deleted}, and ${uploads} unpublished upload${uploads === 1 ? '' : 's'}`)
await db.$client.end()
