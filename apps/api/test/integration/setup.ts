import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { db } from '../../src/db/index.js'
import { ensureBucket } from '../../src/storage.js'

// No real email in integration tests: assert on these mocks instead
vi.mock('../../src/mail.js', () => ({
  sendSignInLink: vi.fn(async () => {}),
  sendShareNotice: vi.fn(async () => {}),
  sendInvitation: vi.fn(async () => {}),
  sendSalesInquiry: vi.fn(async () => {}),
}))

if (!process.env.DATABASE_URL?.includes('artifact_test')) throw new Error('Integration tests must use the artifact_test database')

beforeAll(async () => {
  await ensureBucket()
})

beforeEach(async () => {
  vi.clearAllMocks()
  // Every app table, so tables added later are cleaned up too
  const rows = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`)
  const tables = [...rows].map((r) => `"public"."${r.tablename}"`)
  if (tables.length) await db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`))
})

afterAll(async () => {
  await db.$client.end()
})
