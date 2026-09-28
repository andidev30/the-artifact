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
import { batchViewCounts, stopViewCounts } from './views.js'

// The Docker image sets MIGRATE_ON_START, so installs bring their database up to date on every start
if (env.migrateOnStart) {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
  await migrate(db, { migrationsFolder })
  log.info('Database is up to date')
}

await ensureBucket()
scheduleSweeps()
// This process outlives its requests, so view counts are summed in memory and written every few
// seconds (src/views.ts). Vercel's entry (api/index.js) doesn't call this and writes each view.
batchViewCounts()

const server = serve(
  {
    fetch: app.fetch,
    port: env.port,
  },
  (info) => {
    log.info('Server is running', { port: info.port })
  },
)

// Docker, Kubernetes and systemd stop with SIGTERM: finish the requests in flight, then write the
// view counts they added. Only a crash or a SIGKILL loses the last few seconds of counts.
let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log.info('Shutting down', { signal })
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    // Keep-alive connections would hold close() open; give requests in flight a few seconds
    setTimeout(resolve, 5_000).unref()
  })
  await stopViewCounts()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
