import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { app } from './app.js'
import { db } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { scheduleSweeps } from './gc.js'
import { ensureBucket } from './storage.js'

// The Docker image sets MIGRATE_ON_START, so installs bring their database up to date on every start
if (env.migrateOnStart) {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
  await migrate(db, { migrationsFolder })
  log.info('Database is up to date')
}

await ensureBucket()
scheduleSweeps()

serve(
  {
    fetch: app.fetch,
    port: env.port,
  },
  (info) => {
    log.info('Server is running', { port: info.port })
  },
)
