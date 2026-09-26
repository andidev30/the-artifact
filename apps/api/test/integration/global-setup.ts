import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Brings the dedicated test database up to the latest migration once per run
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test'
  if (!url.includes('artifact_test')) throw new Error(`Refusing to run integration tests against ${url}`)
  const client = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
  } finally {
    await client.end()
  }
}
