import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { trackingSettled } from '../../src/analytics.js'
import { auditSettled } from '../../src/audit.js'
import { clearFileCache } from '../../src/artifacts.js'
import { forgetSsoButtons } from '../../src/ee/sso/connections.js'
import { forgetAccounts } from '../../src/instance.js'
import { db } from '../../src/db/index.js'
import { ensureBucket } from '../../src/storage.js'
import { batchViewCounts, forgetPendingViewCounts } from '../../src/views.js'

// No real email in integration tests: assert on these mocks instead
vi.mock('../../src/mail.js', () => ({
  sendSignInLink: vi.fn(async () => {}),
  sendShareNotice: vi.fn(async () => {}),
  sendInvitation: vi.fn(async () => {}),
  sendCommentNotice: vi.fn(async () => {}),
}))
vi.mock('../../src/ee/mail.js', () => ({
  sendSalesInquiry: vi.fn(async () => {}),
}))

if (!process.env.DATABASE_URL?.includes('artifact_test')) throw new Error('Integration tests must use the artifact_test database')

beforeAll(async () => {
  await ensureBucket()
  // Batched like the long-running server, without the timer: tests write counts with flushViews
  batchViewCounts({ every: 0 })
})

beforeEach(async () => {
  vi.clearAllMocks()
  // Audit and product events the last test started writing, so none lands after the truncate
  await auditSettled()
  await trackingSettled()
  // Every app table, so tables added later are cleaned up too
  const rows = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`)
  const tables = [...rows].map((r) => `"public"."${r.tablename}"`)
  if (tables.length) await db.execute(sql.raw(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`))
  // In-process caches of what was just truncated behind the app's back
  clearFileCache()
  forgetAccounts()
  forgetSsoButtons()
  forgetPendingViewCounts()
})

afterAll(async () => {
  await db.$client.end()
})
