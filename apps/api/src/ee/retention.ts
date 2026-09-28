import { and, eq, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { enterprise, enterpriseRequired, hasEnterprise } from '../license.js'
import { log } from '../log.js'
import { UUID_RE } from '../validation.js'

// Version retention, an enterprise feature: an organization's owners and admins choose how long
// older versions of its pages are kept, by age and by count. The current version of a page is never
// removed, and pages themselves never are. A policy is kept when the license lapses but is applied
// only while the install has an Enterprise license (active or in its grace period). Like pruneHistory
// in ee/plans.ts, this deletes version rows only; the storage sweep then removes content nothing
// refers to any more.

export const MAX_KEEP_DAYS = 3650
export const MAX_KEEP_VERSIONS = 10_000

export type Policy = { keepDays: number | null; keepVersions: number | null }

// Versions a policy removes, as (id, artifact_id) rows. `policies` has organization_id, keep_days
// and keep_versions; count is by version number, newest first, so the current version counts too.
function expiredVersions(policies: SQL, now: Date): SQL {
  return sql`
    select r.id, r.artifact_id from (
      select v.id, v.artifact_id, v.version, v.created_at, a.current_version, p.keep_days, p.keep_versions,
        row_number() over (partition by v.artifact_id order by v.version desc) as rank
      from ${schema.artifactVersions} v
      join ${schema.artifacts} a on a.id = v.artifact_id
      join ${policies} p on p.organization_id = a.organization_id
    ) r
    where r.version <> r.current_version
      and (
        (r.keep_days is not null and r.created_at < ${now.toISOString()}::timestamptz - make_interval(days => r.keep_days))
        or (r.keep_versions is not null and r.rank > r.keep_versions)
      )`
}

function onePolicy(organizationId: string, policy: Policy): SQL {
  return sql`(select ${organizationId}::uuid as organization_id, ${policy.keepDays}::int as keep_days, ${policy.keepVersions}::int as keep_versions)`
}

// What saving `policy` would remove from the organization right now
export async function previewRetention(organizationId: string, policy: Policy, now = new Date()): Promise<{ versions: number; pages: number }> {
  if (policy.keepDays === null && policy.keepVersions === null) return { versions: 0, pages: 0 }
  const [row] = await db.execute<{ versions: number; pages: number }>(sql`
    select count(*)::int as versions, count(distinct x.artifact_id)::int as pages
    from (${expiredVersions(onePolicy(organizationId, policy), now)}) x`)
  return { versions: row.versions, pages: row.pages }
}

// Applies every organization's policy. Runs before each storage sweep (src/gc.ts), on a self-hosted
// server's timer and from /api/cron/sweep.
export async function pruneRetention(now = new Date()): Promise<number> {
  if (!(await hasEnterprise(now))) return 0
  const deleted = await db.execute(sql`
    delete from ${schema.artifactVersions}
    where id in (select id from (${expiredVersions(sql`${schema.retentionPolicies}`, now)}) x)
    returning id`)
  if (deleted.length) log.info('Retention removed older versions', { deleted: deleted.length })
  return deleted.length
}

type Parsed = { ok: true; policy: Policy } | { ok: false; error: string; field: string }

function limit(value: unknown, max: number): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max ? n : undefined
}

export function parsePolicy(body: { keepDays?: unknown; keepVersions?: unknown } | null): Parsed {
  const keepDays = limit(body?.keepDays, MAX_KEEP_DAYS)
  if (keepDays === undefined) return { ok: false, error: `Keep versions for 1 to ${MAX_KEEP_DAYS} days, or forever.`, field: 'keepDays' }
  const keepVersions = limit(body?.keepVersions, MAX_KEEP_VERSIONS)
  if (keepVersions === undefined) return { ok: false, error: `Keep 1 to ${MAX_KEEP_VERSIONS} versions per page, or no limit.`, field: 'keepVersions' }
  return { ok: true, policy: { keepDays, keepVersions } }
}

// Mounted at /api/organizations/:orgId/retention. Owners and admins only; everyone else, and
// organizations the person isn't in, get the same 404. Not on the hosted service, which has no
// Enterprise plan yet.
export const retention = new Hono<AuthEnv>()
retention.use(requireUser)

const NOT_FOUND = { error: 'Not found' }

async function managedOrg(c: Context<AuthEnv>): Promise<string | null> {
  const orgId = c.req.param('orgId') ?? ''
  const user = c.get('user')!
  if (!env.selfHosted || !UUID_RE.test(orgId) || user.blockedOrgs.includes(orgId)) return null
  const [row] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, user.id)))
  return row && row.role !== 'member' ? orgId : null
}

async function current(organizationId: string) {
  const [row] = await db.select().from(schema.retentionPolicies).where(eq(schema.retentionPolicies.organizationId, organizationId))
  const { status } = await enterprise()
  return {
    keepDays: row?.keepDays ?? null,
    keepVersions: row?.keepVersions ?? null,
    updatedAt: row?.updatedAt ?? null,
    license: status,
    // Whether the daily job applies it; without an Enterprise license the policy is kept but not applied
    applied: Boolean(row) && (status === 'active' || status === 'grace'),
  }
}

retention.get('/', async (c) => {
  const orgId = await managedOrg(c)
  if (!orgId) return c.json(NOT_FOUND, 404)
  return c.json(await current(orgId))
})

retention.get('/preview', async (c) => {
  const orgId = await managedOrg(c)
  if (!orgId) return c.json(NOT_FOUND, 404)
  if (!(await hasEnterprise())) return c.json(enterpriseRequired, 403)
  const parsed = parsePolicy({ keepDays: c.req.query('keepDays'), keepVersions: c.req.query('keepVersions') })
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  return c.json(await previewRetention(orgId, parsed.policy))
})

retention.put('/', async (c) => {
  const orgId = await managedOrg(c)
  if (!orgId) return c.json(NOT_FOUND, 404)
  const parsed = parsePolicy((await c.req.json().catch(() => null)) as Parameters<typeof parsePolicy>[0])
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  const { keepDays, keepVersions } = parsed.policy
  const user = c.get('user')!
  if (keepDays === null && keepVersions === null) {
    // Turning retention off is allowed without a license, so a lapsed install can drop a policy
    await db.delete(schema.retentionPolicies).where(eq(schema.retentionPolicies.organizationId, orgId))
  } else {
    if (!(await hasEnterprise())) return c.json(enterpriseRequired, 403)
    const values = { keepDays, keepVersions, updatedBy: user.id, updatedAt: new Date() }
    await db
      .insert(schema.retentionPolicies)
      .values({ organizationId: orgId, ...values })
      .onConflictDoUpdate({ target: schema.retentionPolicies.organizationId, set: values })
  }
  log.info('Retention policy changed', { organizationId: orgId, userId: user.id, keepDays, keepVersions })
  return c.json(await current(orgId))
})
