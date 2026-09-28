import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { checkServerSecrets } from './secrets.js'
import { ensureBucket } from './storage.js'

// What a server does once as it starts, before it serves anything: in the only process, or in a
// cluster's primary before it starts the workers
export async function prepare() {
  // The Docker image sets MIGRATE_ON_START, so installs bring their database up to date on every start
  if (env.migrateOnStart) {
    const migrationsFolder = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
    await migrate(db, { migrationsFolder })
    log.info('Database is up to date')
  }
  // Stops here rather than serving with keys it can't open: sign-ins with an authenticator app,
  // webhooks and page links would all fail
  try {
    const encrypted = await checkServerSecrets()
    if (encrypted) log.info('Encrypted the server secrets with ENCRYPTION_KEY', { rows: encrypted })
  } catch (err) {
    log.error('Could not open the server secrets', { err })
    throw err
  }
  await ensureBucket()
}
