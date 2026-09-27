import postgres from 'postgres'
import { migrateTestDatabase } from './integration/global-setup.js'

// Database access for Playwright specs, which drive the real servers and can't reach into the API's code.

export const HOSTED_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test'

// The self-hosted e2e server has a database of its own, emptied at the start of every run, so its first
// account really is the first one
export const SELF_HOSTED_DATABASE_URL = process.env.TEST_SELF_HOSTED_DATABASE_URL ?? 'postgres://artifact:artifact@localhost:5432/artifact_test_selfhosted'

async function withDatabase<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  if (!url.includes('artifact_test')) throw new Error(`Refusing to change ${url}`)
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

// e2e never truncates the hosted database, so "the first account" there is long taken.
// Specs that need an instance admin sign up a fresh person and grant it here.
export async function grantInstanceAdmin(email: string) {
  await withDatabase(HOSTED_DATABASE_URL, async (sql) => {
    const rows = await sql`update users set is_admin = true where email = ${email.toLowerCase()} returning id`
    if (rows.length !== 1) throw new Error(`No account for ${email}`)
  })
}

// Creates the self-hosted database on first use, migrates it and deletes everything in it
export async function resetSelfHostedDatabase() {
  if (SELF_HOSTED_DATABASE_URL === HOSTED_DATABASE_URL) throw new Error('TEST_SELF_HOSTED_DATABASE_URL must differ from TEST_DATABASE_URL')
  const target = new URL(SELF_HOSTED_DATABASE_URL)
  const name = decodeURIComponent(target.pathname.slice(1))
  const maintenance = new URL(SELF_HOSTED_DATABASE_URL)
  maintenance.pathname = '/postgres'
  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} })
  try {
    const [found] = await admin`select 1 from pg_database where datname = ${name}`
    if (!found) await admin.unsafe(`create database "${name.replaceAll('"', '""')}"`)
  } finally {
    await admin.end()
  }

  await migrateTestDatabase(SELF_HOSTED_DATABASE_URL)
  await withDatabase(SELF_HOSTED_DATABASE_URL, async (sql) => {
    const rows = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`
    const tables = rows.map((r) => `"public"."${r.tablename}"`)
    if (tables.length) await sql.unsafe(`truncate ${tables.join(', ')} restart identity cascade`)
  })
}

export async function selfHostedAccountCount(): Promise<number> {
  return withDatabase(SELF_HOSTED_DATABASE_URL, async (sql) => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from users`
    return row.n
  })
}

// An account in the state sign-up leaves it in, written directly so specs can reproduce states the
// server no longer creates for them (an account from before new accounts started onboarded) or only
// creates once per install (the first account)
export async function createSelfHostedAccount(email: string, { isAdmin }: { isAdmin: boolean }) {
  await withDatabase(SELF_HOSTED_DATABASE_URL, async (sql) => {
    await sql`insert into users (email, is_admin, onboarded_at) values (${email.toLowerCase()}, ${isAdmin}, null)`
  })
}
