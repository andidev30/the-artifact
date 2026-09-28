import { eq, sql } from 'drizzle-orm'
import { type db, schema } from './db/index.js'
import { env } from './env.js'
import { PublishError } from './files.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// What one workspace (a person's personal workspace, or an organization) may hold. Storage is the
// size of every version of its pages, each counted in full (HTML and files), as people see it in a
// page's history: content that versions share is stored once, but a quota people can't work out
// from what they see would be a surprise. Restoring an old version adds a version, so it counts too.
export type Quota = {
  pages?: number | null
  versions?: number | null
  bytes?: number | null
  // Who sets it, for the message: "the free Personal plan", "this server"
  by: string
  // Appended to the storage message, e.g. how the plan frees space by itself
  hint?: string
}

export type Workspace = { userId: string; organizationId: string | null }

// A quota that depends on the workspace's plan, set once by an entry point (src/app.ts sets the
// hosted service's plans from ee/). null falls back to the server's own WORKSPACE_MAX_* settings.
export type PlanQuota = (workspace: Workspace) => Quota | null
let planQuota: PlanQuota | null = null

export function setPlanQuota(source: PlanQuota) {
  planQuota = source
}

function serverQuota(): Quota | null {
  const { pages, versions, bytes } = env.workspaceQuota
  return pages || versions || bytes ? { pages, versions, bytes, by: 'this server' } : null
}

export function quotaFor(workspace: Workspace): Quota | null {
  return planQuota?.(workspace) ?? serverQuota()
}

export function formatSize(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return i === 0 ? `${n} bytes` : `${Number(n.toFixed(1))} ${units[i]}`
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

// Refuses, with a PublishError, what would take the workspace past its quota. Runs inside the
// transaction that adds the page or version, and locks the workspace's row first, so two publishes
// at once can't both take the last of the room.
export async function checkQuota(tx: Tx, workspace: Workspace, adding: { page: boolean; bytes: number }) {
  const quota = quotaFor(workspace)
  if (!quota) return
  const { userId, organizationId } = workspace
  if (organizationId) {
    await tx.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, organizationId)).for('no key update')
  } else {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).for('no key update')
  }
  const scope = organizationId ? sql`a.organization_id = ${organizationId}` : sql`a.owner_id = ${userId} and a.organization_id is null`
  const [used] = await tx.execute<{ pages: number; versions: number; bytes: number }>(sql`
    select
      (select count(*) from artifacts a where ${scope})::int as pages,
      (select count(*) from artifact_versions v join artifacts a on a.id = v.artifact_id where ${scope})::int as versions,
      (select coalesce(sum(v.html_size), 0) from artifact_versions v join artifacts a on a.id = v.artifact_id where ${scope})::float8
        + (select coalesce(sum(f.size), 0) from artifact_files f join artifact_versions v on v.id = f.version_id join artifacts a on a.id = v.artifact_id where ${scope})::float8
        as bytes`)

  const where = organizationId ? 'This organization' : 'Your personal workspace'
  if (adding.page && quota.pages && used.pages >= quota.pages) {
    throw new PublishError(
      `${where} has ${count(used.pages, 'page')}, the most ${quota.by} allows. ` +
        'Publish a new version of a page you have (pass its artifact_id), or delete one you no longer need in the gallery.',
    )
  }
  if (quota.versions && used.versions >= quota.versions) {
    throw new PublishError(
      `${where} has ${count(used.versions, 'version')} of its pages, the most ${quota.by} allows. Delete pages you no longer need in the gallery to make room.`,
    )
  }
  if (quota.bytes && used.bytes + adding.bytes > quota.bytes) {
    throw new PublishError(
      `This would take ${organizationId ? 'this organization' : 'your personal workspace'} past ${formatSize(quota.bytes)} of storage, the most ${quota.by} allows ` +
        `(${formatSize(used.bytes)} used, this version is ${formatSize(adding.bytes)}). ` +
        `Delete pages you no longer need in the gallery, or make the page smaller.${quota.hint ? ` ${quota.hint}` : ''}`,
    )
  }
}
