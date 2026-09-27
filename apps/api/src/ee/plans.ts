import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import type { PlanQuota } from '../quota.js'
import { requireCronSecret } from '../routes/cron.js'

// The hosted service's free Personal plan: a personal workspace holds up to PERSONAL_PAGES pages and
// PERSONAL_STORAGE_BYTES of versions (src/quota.ts says what counts), and keeps older versions for
// PERSONAL_HISTORY_DAYS. The pricing page (apps/web/src/ee/Pricing.tsx) promises the same numbers.
// Organizations have no limits until they have billing (#34). None of this applies to a self-hosted
// install.
export const PERSONAL_PAGES = 50
export const PERSONAL_STORAGE_BYTES = 1024 ** 3
export const PERSONAL_HISTORY_DAYS = 7

export const personalPlan: PlanQuota = ({ organizationId }) => {
  if (env.selfHosted || organizationId) return null
  return {
    pages: PERSONAL_PAGES,
    bytes: PERSONAL_STORAGE_BYTES,
    by: 'the free Personal plan',
    hint: `Versions older than ${PERSONAL_HISTORY_DAYS} days are removed every day, which frees space as well.`,
  }
}

// Deletes versions of personal pages that are older than the plan keeps, never a page's current
// version. Their files and thumbnails go with them, and the storage sweep then removes the content
// nothing refers to any more.
export async function pruneHistory(now = new Date()): Promise<number> {
  if (env.selfHosted) return 0
  const cutoff = new Date(now.getTime() - PERSONAL_HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const deleted = await db.execute(sql`
    delete from ${schema.artifactVersions} v
    using ${schema.artifacts} a
    where v.artifact_id = a.id
      and a.organization_id is null
      and v.version <> a.current_version
      and v.created_at < ${cutoff.toISOString()}::timestamptz
    returning v.id`)
  return deleted.length
}

// Called daily by Vercel Cron (vercel.json), before the storage sweep
export const historyCron = new Hono()
historyCron.use(requireCronSecret)
historyCron.get('/', async (c) => {
  if (env.selfHosted) return c.json({ error: 'Not found' }, 404)
  return c.json({ deleted: await pruneHistory() })
})
