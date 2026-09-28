// Indexes the text of every page's current version for search, for pages published before search
// looked inside pages or that missed it. The server does this too, a few hundred pages per storage
// sweep; this does all of them at once. --all indexes every page again, not only those missing.
//   pnpm --filter @the-artifact/api search:backfill [--all]
//   docker compose exec app node dist/scripts/backfill-search.js [--all]
import { db, schema } from '../db/index.js'
import { indexPage, staleIds } from '../search.js'

const all = process.argv.includes('--all')
const CONCURRENCY = 4

const ids = all ? (await db.select({ id: schema.artifacts.id }).from(schema.artifacts)).map((r) => r.id) : await staleIds()

console.log(`${ids.length} page${ids.length === 1 ? '' : 's'} to index`)
let done = 0
let failed = 0
const next = ids.values()
async function worker() {
  for (const id of next) {
    try {
      await indexPage(id)
    } catch (err) {
      failed += 1
      console.error(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
    done += 1
    if (done % 100 === 0 || done === ids.length) console.log(`${done}/${ids.length}`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
await db.$client.end()
console.log(failed ? `Done, ${failed} failed (run it again to retry them)` : 'Done')
if (failed) process.exitCode = 1
