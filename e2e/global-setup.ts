import { HOSTED_DATABASE_URL, resetSelfHostedDatabase } from '../apps/api/test/e2e-db.ts'
import { migrateTestDatabase } from '../apps/api/test/integration/global-setup.ts'

// The e2e APIs run without MIGRATE_ON_START, so bring both databases up to date first
export default async function setup() {
  await migrateTestDatabase(HOSTED_DATABASE_URL)
  await resetSelfHostedDatabase()
}
