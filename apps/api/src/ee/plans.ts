import { and, count, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { NewPageCheck } from '../artifacts.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { PublishError } from '../files.js'
import { requireCronSecret } from '../routes/cron.js'

// The hosted service's free Personal plan: a personal workspace holds up to PERSONAL_PAGES pages and
// keeps older versions for PERSONAL_HISTORY_DAYS. The pricing page (apps/web/src/ee/Pricing.tsx)
// promises the same numbers. Organizations have no limits until they have billing (#34). None of
// this applies to a self-hosted install.
export const PERSONAL_PAGES = 50
export const PERSONAL_HISTORY_DAYS = 7

export const personalPageLimit: NewPageCheck = async (tx, { userId, organizationId }) => {
  if (env.selfHosted || organizationId) return
  // Locks the owner, so two publishes at once can't both take the last free place
  await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for('update')
  const [{ pages }] = await tx
    .select({ pages: count() })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.ownerId, userId), isNull(schema.artifacts.organizationId)))
  if (pages >= PERSONAL_PAGES) {
    throw new PublishError(
      `Your personal workspace has ${pages} pages, the most the free Personal plan allows. ` +
        'Publish a new version of a page you have (pass its artifact_id), or delete one you no longer need in the gallery.',
    )
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
