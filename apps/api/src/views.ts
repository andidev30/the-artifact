import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import { log } from './log.js'

// Views of a page: a count per version for everyone, and who opened it and when for people who
// opened it as themselves. Visits to a page shared by link stay anonymous: they only add to the count.
//
// Recording sits on the path that serves pages, so it is cheap: repeat views by the same person or
// visitor within REPEAT_MINUTES are dropped in memory before touching the database, and a counted
// view is one statement.

export const VIEWER_RETENTION_DAYS = 90
export const REPEAT_MINUTES = 30
const REPEAT_MS = REPEAT_MINUTES * 60_000

// Keys are salted hashes, and the salt never leaves this process, so memory holds no addresses
const SALT = randomBytes(16)
const MAX_REMEMBERED = 50_000
const recent = new Map<string, number>()

// True the first time a key is seen within the window. Each process keeps its own map, so with
// several replicas a repeat can still be counted once per replica; the database check below covers
// identified viewers.
export function firstInWindow(key: string, now = Date.now()): boolean {
  const hashed = createHash('sha256').update(SALT).update(key).digest('base64url')
  const last = recent.get(hashed)
  if (last !== undefined && now - last < REPEAT_MS) return false
  // Re-inserted so the map stays oldest first, which is the order it is trimmed in
  recent.delete(hashed)
  recent.set(hashed, now)
  if (recent.size > MAX_REMEMBERED) {
    for (const k of recent.keys()) {
      recent.delete(k)
      if (recent.size <= MAX_REMEMBERED * 0.9) break
    }
  }
  return true
}

export function forgetRecentViews() {
  recent.clear()
}

type ViewInput = {
  artifact: Artifact
  version: number
  versionId: string
  // Who is looking, when the request knows. Only stored when identified is true.
  viewerId: string | null
  // False for a page opened through its shared link, which is recorded without anyone's identity
  identified: boolean
  // For telling anonymous visitors apart in memory: their address and browser. Never stored.
  visitor: string
}

// Never throws: a view that can't be recorded must not stop the page from loading
export async function recordView(input: ViewInput, now = Date.now()): Promise<void> {
  const { artifact, version, versionId, viewerId } = input
  // Owners looking at their own page aren't an audience
  if (viewerId === artifact.ownerId) return
  const identified = input.identified && viewerId !== null
  const who = identified ? `u:${viewerId}` : `a:${input.visitor}`
  if (!firstInWindow(`${who}|${artifact.id}|${version}`, now)) return
  try {
    if (identified) {
      // The not-exists check catches repeats another replica already counted
      await db.execute(sql`
        with added as (
          insert into artifact_views (artifact_id, version, user_id)
          select ${artifact.id}, ${version}, ${viewerId}
          where not exists (
            select 1 from artifact_views
            where artifact_id = ${artifact.id} and user_id = ${viewerId} and version = ${version}
              and viewed_at > now() - make_interval(mins => ${REPEAT_MINUTES}))
          returning 1)
        insert into artifact_view_counts (version_id, views)
        select ${versionId}, 1 from added
        on conflict (version_id) do update set views = artifact_view_counts.views + 1`)
    } else {
      await db.execute(sql`
        insert into artifact_view_counts (version_id, views) values (${versionId}, 1)
        on conflict (version_id) do update set views = artifact_view_counts.views + 1`)
    }
  } catch (err) {
    log.warn('Recording a view failed', { err })
  }
}

// Views of every version, newest first
export async function versionViews(artifact: Artifact) {
  return db
    .select({ version: schema.artifactVersions.version, views: sql<number>`coalesce(${schema.artifactViewCounts.views}, 0)::int` })
    .from(schema.artifactVersions)
    .leftJoin(schema.artifactViewCounts, eq(schema.artifactViewCounts.versionId, schema.artifactVersions.id))
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
    .orderBy(desc(schema.artifactVersions.version))
}

export async function totalViews(artifact: Artifact): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${schema.artifactViewCounts.views}), 0)::int` })
    .from(schema.artifactViewCounts)
    .innerJoin(schema.artifactVersions, eq(schema.artifactViewCounts.versionId, schema.artifactVersions.id))
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
  return row?.n ?? 0
}

export const MAX_VIEWERS = 200

// Who opened the page in the last VIEWER_RETENTION_DAYS, most recent first: one row per person
export async function pageViewers(artifact: Artifact, limit = MAX_VIEWERS) {
  const v = schema.artifactViews
  return db
    .select({
      name: schema.users.name,
      email: schema.users.email,
      visits: sql<number>`count(*)::int`,
      lastViewedAt: sql<Date>`max(${v.viewedAt})`.mapWith((value: string | Date) => new Date(value)),
      lastVersion: sql<number>`(array_agg(${v.version} order by ${v.viewedAt} desc))[1]`,
    })
    .from(v)
    .innerJoin(schema.users, eq(v.userId, schema.users.id))
    .where(and(eq(v.artifactId, artifact.id), sql`${v.viewedAt} > now() - make_interval(days => ${VIEWER_RETENTION_DAYS})`))
    .groupBy(schema.users.id, schema.users.name, schema.users.email)
    .orderBy(desc(sql`max(${v.viewedAt})`))
    .limit(limit)
}

// Run by the daily jobs; the counts stay
export async function deleteOldViews(): Promise<number> {
  const rows = await db.execute(sql`delete from artifact_views where viewed_at < now() - make_interval(days => ${VIEWER_RETENTION_DAYS}) returning 1`)
  return rows.length
}
