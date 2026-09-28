import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { likeTerm } from '../artifacts.js'
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry, type AuditStore } from '../audit.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { hasEnterprise, requireEnterprise } from '../license.js'
import { UUID_RE } from '../validation.js'

// The audit log of an organization, an Enterprise feature: src/audit.ts hands events here, which are
// kept only while the install's license is active or in its grace period (the hosted service has
// none, so nothing is kept there). Owners and admins read and export it in organization settings.

const e = schema.auditEvents
const DAY = 24 * 60 * 60 * 1000
const PRUNE_BATCH = 10_000

async function record(entry: AuditEntry) {
  if (!(await hasEnterprise(entry.at))) return
  const orgIds =
    'memberOf' in entry
      ? (await db.select({ id: schema.memberships.organizationId }).from(schema.memberships).where(eq(schema.memberships.userId, entry.memberOf))).map(
          (m) => m.id,
        )
      : [entry.organizationId as string]
  if (!orgIds.length) return
  await db.insert(e).values(
    orgIds.map((organizationId) => ({
      organizationId,
      action: entry.action,
      actorId: entry.actor?.id ?? null,
      actorEmail: entry.actor?.email ?? null,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.target?.label ?? null,
      details: entry.details ?? {},
      ip: entry.ip,
      userAgent: entry.userAgent,
      createdAt: entry.at,
    })),
  )
}

// Also while no license counts, so events recorded before it lapsed still go when their time is up
export async function pruneAuditEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.auditLogRetentionDays * DAY)
  let deleted = 0
  // In batches, so a first run over a large table doesn't hold one long transaction
  for (;;) {
    const rows = await db.execute(
      sql`delete from ${e} where ${e.id} in (select ${e.id} from ${e} where ${e.createdAt} < ${cutoff.toISOString()}::timestamptz limit ${PRUNE_BATCH}) returning 1`,
    )
    deleted += rows.length
    if (rows.length < PRUNE_BATCH) return deleted
  }
}

export const auditStore: AuditStore = { record }

// Mounted at /api/organizations/:orgId/audit-log
export const auditLog = new Hono<AuthEnv>()
auditLog.use(requireUser)

// Owners and admins only; to everyone else the log looks missing, like an organization they aren't in
auditLog.use(async (c, next) => {
  const orgId = c.req.param('orgId') ?? ''
  const user = c.get('user')!
  if (!UUID_RE.test(orgId) || user.blockedOrgs.includes(orgId)) return c.json({ error: 'Not found' }, 404)
  const [member] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user.id)))
  if (!member || member.role === 'member') return c.json({ error: 'Not found' }, 404)
  await next()
})
auditLog.use(requireEnterprise)

const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const EXPORT_BATCH = 1000

// The cursor is the (created_at, id) of the last row. created_at goes through as text with every
// microsecond, which a JavaScript Date would round to milliseconds and so skip or repeat rows.
const CURSOR_AT = sql<string>`to_char(${e.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url')

type Filters = { ok: true; where: SQL } | { ok: false; error: string; field: string }

// ?action= one action; ?actor= part of the email of who did it; ?from= and ?to= a date (YYYY-MM-DD,
// UTC) or an ISO time, from inclusive and to exclusive; ?cursor= the next value of the page before
function filters(c: Context<AuthEnv>): Filters {
  const where: (SQL | undefined)[] = [eq(e.organizationId, c.req.param('orgId')!)]
  const action = c.req.query('action')
  if (action) {
    if (!AUDIT_ACTIONS.includes(action as AuditAction)) return { ok: false, error: 'Choose an action from the list.', field: 'action' }
    where.push(eq(e.action, action))
  }
  const actor = c.req.query('actor')?.trim().slice(0, 254)
  if (actor) where.push(ilike(e.actorEmail, likeTerm(actor)))
  for (const field of ['from', 'to'] as const) {
    const value = c.req.query(field)
    if (!value) continue
    const at = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) ? new Date(value) : null
    if (!at || Number.isNaN(at.getTime())) return { ok: false, error: 'Enter a date like 2026-01-31.', field }
    where.push(field === 'from' ? gte(e.createdAt, at) : lt(e.createdAt, at))
  }
  const cursor = c.req.query('cursor')
  if (cursor) {
    const [at = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    if (!CURSOR_RE.test(at) || !UUID_RE.test(id)) {
      return { ok: false, error: 'This list changed while you were reading it. Start again from the first page.', field: 'cursor' }
    }
    where.push(before({ at, id }))
  }
  return { ok: true, where: and(...where)! }
}

type Position = { at: string; id: string }

const before = (p: Position) => sql`(${e.createdAt}, ${e.id}) < (${p.at}::timestamptz, ${p.id}::uuid)`

// Rows one past the limit say whether there is a next page
async function page(where: SQL, limit: number, after?: Position) {
  const rows = await db
    .select({ event: e, cursorAt: CURSOR_AT })
    .from(e)
    .where(after ? and(where, before(after)) : where)
    .orderBy(desc(e.createdAt), desc(e.id))
    .limit(limit + 1)
  const last = rows.length > limit ? rows[limit - 1] : null
  return { events: rows.slice(0, limit).map((r) => describe(r.event)), next: last ? { at: last.cursorAt, id: last.event.id } : null }
}

function describe(row: typeof e.$inferSelect) {
  return {
    id: row.id,
    action: row.action,
    at: row.createdAt.toISOString(),
    actor: row.actorEmail || row.actorId ? { id: row.actorId, email: row.actorEmail } : null,
    target: row.targetType ? { type: row.targetType, id: row.targetId, label: row.targetLabel } : null,
    details: row.details,
    ip: row.ip,
    userAgent: row.userAgent,
  }
}

auditLog.get('/', async (c) => {
  const f = filters(c)
  if (!f.ok) return c.json({ error: f.error, field: f.field }, 400)
  const n = Number(c.req.query('limit') ?? PAGE_SIZE)
  const limit = Number.isFinite(n) ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(n))) : PAGE_SIZE
  const { events, next } = await page(f.where, limit)
  return c.json({ events, next: next ? encodeCursor(next.at, next.id) : null, actions: AUDIT_ACTIONS, retentionDays: env.auditLogRetentionDays })
})

const CSV_COLUMNS = ['time', 'action', 'actor_email', 'actor_id', 'target_type', 'target_id', 'target_label', 'details', 'ip', 'user_agent'] as const

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  // Spreadsheets run cells that start like a formula; page titles and user agents come from anyone
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRow(ev: ReturnType<typeof describe>): string {
  const cells = [ev.at, ev.action, ev.actor?.email, ev.actor?.id, ev.target?.type, ev.target?.id, ev.target?.label, ev.details, ev.ip, ev.userAgent]
  return `${cells.map(csvCell).join(',')}\r\n`
}

// ?format=csv or json, with the same filters as the list; every matching event, newest first,
// written as it is read so a year of events doesn't sit in memory
auditLog.get('/export', async (c) => {
  const format = c.req.query('format') ?? 'csv'
  if (format !== 'csv' && format !== 'json') return c.json({ error: 'Choose csv or json.', field: 'format' }, 400)
  const f = filters(c)
  if (!f.ok) return c.json({ error: f.error, field: f.field }, 400)
  const [org] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, c.req.param('orgId')!))

  const encoder = new TextEncoder()
  let cursor: Position | undefined
  let first = true
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(format === 'csv' ? `${CSV_COLUMNS.join(',')}\r\n` : '['))
    },
    async pull(controller) {
      const { events, next } = await page(f.where, EXPORT_BATCH, cursor)
      let chunk = ''
      for (const ev of events) {
        chunk += format === 'csv' ? csvRow(ev) : `${first ? '\n' : ',\n'}${JSON.stringify(ev)}`
        first = false
      }
      if (chunk) controller.enqueue(encoder.encode(chunk))
      if (next) cursor = next
      else {
        if (format === 'json') controller.enqueue(encoder.encode('\n]\n'))
        controller.close()
      }
    },
  })
  const day = new Date().toISOString().slice(0, 10)
  return c.body(body, 200, {
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="audit-log-${org.slug}-${day}.${format}"`,
    'Cache-Control': 'no-store',
  })
})
