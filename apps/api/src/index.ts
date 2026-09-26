import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { app } from './app.js'
import { db } from './db/index.js'
import { env } from './env.js'
import { scheduleSweeps } from './gc.js'
import { moveContentToStorage } from './storage-move.js'
import { ensureBucket } from './storage.js'

// Self-hosted installs bring their database up to date on every start
if (env.migrateOnStart) {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
  await migrate(db, { migrationsFolder })
  console.log('Database is up to date')
}

await ensureBucket()
const moved = await moveContentToStorage()
if (moved) console.log(`Moved ${moved} stored item${moved === 1 ? '' : 's'} from the database to object storage`)
scheduleSweeps()

serve({
  fetch: app.fetch,
  port: env.port
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
