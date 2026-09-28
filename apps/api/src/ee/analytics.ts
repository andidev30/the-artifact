import { sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { PRODUCT_EVENTS, SIGN_UP_METHODS, type ProductEvent, type ProductEventStore } from '../analytics.js'
import type { AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { isInstanceAdmin } from '../instance.js'

// The hosted service's sign-up funnel, first-party and server-side: src/analytics.ts hands events here,
// and this keeps the first time each account reached each step, plus how many publishes there were
// each day without saying whose. Nothing is kept on a self-hosted install. Rows hold the account id,
// the step, a fixed enum and the time; never page content, titles, email addresses or IP addresses,
// so the table can be exported as it is. They go with the account (the foreign key cascades) and
// after RETENTION_MONTHS, as the Privacy Policy (src/ee/legal/privacy.md in the web app) says.

const pe = schema.productEvents
const daily = schema.productDailyCounts

export const RETENTION_MONTHS = 13
export const FUNNEL_WINDOWS = [7, 30, 90] as const
const PRUNE_BATCH = 10_000
const DAY = 24 * 60 * 60 * 1000

async function record(event: ProductEvent, at: Date) {
  if (env.selfHosted) return
  try {
    await db
      .insert(pe)
      .values({ userId: event.userId, event: event.event, detail: event.detail ?? null, createdAt: at })
      .onConflictDoNothing()
  } catch (err) {
    // The account was deleted between the action and this write: nothing to keep
    if ((err as { code?: string }).code === '23503' || (err as { cause?: { code?: string } }).cause?.code === '23503') return
    throw err
  }
  if (event.event === 'page_published') {
    await db
      .insert(daily)
      .values({ day: at.toISOString().slice(0, 10), event: event.event, count: 1 })
      .onConflictDoUpdate({ target: [daily.day, daily.event], set: { count: sql`${daily.count} + 1` } })
  }
}

export const productEventStore: ProductEventStore = { record }

// Runs on self-hosted installs too, where the tables stay empty, so it never needs to know the mode
export async function pruneProductEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS)
  let deleted = 0
  // In batches, so a first run over a large table doesn't hold one long transaction
  for (;;) {
    const rows = await db.execute(
      sql`delete from ${pe} where ${pe.id} in (select ${pe.id} from ${pe} where ${pe.createdAt} < ${cutoff.toISOString()}::timestamptz limit ${PRUNE_BATCH}) returning 1`,
    )
    deleted += rows.length
    if (rows.length < PRUNE_BATCH) break
  }
  const days = await db.execute(sql`delete from ${daily} where ${daily.day} < ${cutoff.toISOString().slice(0, 10)}::date returning 1`)
  return deleted + days.length
}

type Counts = number[]

// One column per window, w0 for the shortest: `aggregate` counted over the rows where `inWindow(i)` holds
function perWindow(aggregate: SQL, inWindow: (since: string) => SQL, since: string[]) {
  return sql.join(
    since.map((s, i) => sql`coalesce(${aggregate} filter (where ${inWindow(s)}), 0)::int as ${sql.raw(`w${i}`)}`),
    sql`, `,
  )
}

const read = (row: Record<string, unknown> | undefined): Counts => FUNNEL_WINDOWS.map((_, i) => Number(row?.[`w${i}`] ?? 0))

// The funnel of the accounts that signed up in each window: how many of them reached each step, at
// any time since. Accounts from before the funnel was recorded have no sign-up event, so they are left out.
export async function funnel(now = new Date()) {
  const since = FUNNEL_WINDOWS.map((days) => new Date(now.getTime() - days * DAY).toISOString())
  const widest = since[since.length - 1]

  const stepRows = await db.execute<Record<string, unknown>>(sql`
    select e.event, ${perWindow(sql`count(*)`, (s) => sql`c.created_at >= ${s}::timestamptz`, since)}
    from ${pe} e
    join ${pe} c on c.user_id = e.user_id and c.event = 'signed_up' and c.created_at >= ${widest}::timestamptz
    group by e.event`)
  const byStep = new Map([...stepRows].map((r) => [r.event as string, read(r)]))

  const methodRows = await db.execute<Record<string, unknown>>(sql`
    select detail as method, ${perWindow(sql`count(*)`, (s) => sql`created_at >= ${s}::timestamptz`, since)}
    from ${pe} where event = 'signed_up' and created_at >= ${widest}::timestamptz
    group by detail`)
  const byMethod = new Map([...methodRows].map((r) => [r.method as string, read(r)]))

  const [publishes] = await db.execute<Record<string, unknown>>(sql`
    select ${perWindow(sql`sum(count)`, (s) => sql`day >= ${s.slice(0, 10)}::date`, since)}
    from ${daily} where event = 'page_published' and day >= ${widest.slice(0, 10)}::date`)

  return {
    windows: FUNNEL_WINDOWS,
    steps: PRODUCT_EVENTS.map((event) => ({ event, counts: byStep.get(event) ?? read(undefined) })),
    signUpMethods: SIGN_UP_METHODS.map((method) => ({ method, counts: byMethod.get(method) ?? read(undefined) })),
    publishes: read(publishes),
    retentionMonths: RETENTION_MONTHS,
  }
}

// Mounted at /api/admin/analytics. The hosted service's instance admins only; to everyone else,
// and on every self-hosted install, it looks missing.
export const productAnalytics = new Hono<AuthEnv>()

productAnalytics.use(async (c, next) => {
  const user = c.get('user')
  if (env.selfHosted || !user || !isInstanceAdmin(user)) return c.json({ error: 'Not found.' }, 404)
  await next()
})

productAnalytics.get('/funnel', async (c) => c.json(await funnel()))
