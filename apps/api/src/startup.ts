import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db } from './db/index.js'
import { env } from './env.js'
import { needsSetupCode } from './instance.js'
import { log } from './log.js'
import { checkServerSecrets, ServerSecretsError } from './secrets.js'
import { newSetupCode, storeSetupCode } from './setup-code.js'
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
  // webhooks and page links would all fail. A database that isn't there yet (migrated or created
  // after the server starts) doesn't stop it; the secrets are checked again when first used.
  try {
    const encrypted = await checkServerSecrets()
    if (encrypted) log.info('Encrypted the server secrets with ENCRYPTION_KEY', { rows: encrypted })
  } catch (err) {
    if (err instanceof ServerSecretsError) {
      log.error('Could not open the server secrets', { err })
      throw err
    }
    log.warn('Could not read the server secrets yet; they are checked when first used', { err })
  }
  await ensureBucket()
  // Serving goes on without it: SETUP_CODE still works, and a restart prints a new code
  await announceSetupCode().catch((err) => log.error('Could not make a setup code for the first account', { err }))
}

// A fresh self-hosted install: a new code for the first account on every start, printed where only
// the operator reads it (docker compose logs, kubectl logs)
async function announceSetupCode() {
  if (!(await needsSetupCode())) return
  if (env.setupCode) {
    log.info('This server has no accounts yet. Create the first one, its admin, with the setup code in SETUP_CODE.')
    return
  }
  const code = newSetupCode()
  await storeSetupCode(code)
  log.warn(`This server has no accounts yet. Create the first one, its admin, with the setup code ${code}`, { setupCode: code })
}
