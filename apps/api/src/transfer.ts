import { and, eq, sql } from 'drizzle-orm'
import { MAX_TITLE_LENGTH, newSlug, pageTarget, type Viewer } from './artifacts.js'
import { audit } from './audit.js'
import { db, schema } from './db/index.js'
import type { Artifact, Visibility } from './db/schema.js'
import { belongsTo, workspaceOf } from './folders.js'
import { holdStorageLock } from './gc.js'
import { checkQuota, type Workspace } from './quota.js'
import { queueThumbnail } from './thumbnails.js'
import { UUID_RE } from './validation.js'

// Duplicating and moving pages between workspaces (a person's Personal workspace and organizations).
//
// Both take publish rights in the target, as publishing does: Personal is the person's own, and an
// organization is one they are a member of (any role, and not closed to them for want of a second
// factor). On the hosted service that means organizations they already belong to.
//
// A copy is a new page owned by whoever made it: the current version only, pointing at the same blobs,
// Restricted, with no people, link settings, comments or views.
//
// A move keeps the page (its id, link, owner, versions, people, link settings, comments and views) and
// changes its workspace. It takes edit access to the page and a place in the workspace it is in now,
// like filing it into a folder, so people it is only shared with can't carry it off. Personal pages
// are their owner's to move, and only the owner can move a page into Personal: it lands in their own.
// The folder is cleared, since folders belong to one workspace, and a page open to its organization
// becomes Restricted when it moves to Personal (in another organization it is open to that one).
// The organization it arrives in applies its rules from then on (two-factor sign-in, retention, quota).

export class TransferError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
    // An organization that requires a second factor this person hasn't set up
    readonly blockedOrg?: string,
  ) {
    super(message)
  }
}

export const COPY_SUFFIX = ' (copy)'

type Actor = Viewer & { id: string; email: string }

// 'personal' or an organization id, as the web app and agents name workspaces
export function workspaceKey(organizationId: string | null): string {
  return organizationId ?? 'personal'
}

async function organizationName(id: string | null): Promise<string | null> {
  if (!id) return null
  const [row] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, id))
  return row?.name ?? null
}

// The workspace `key` names for this person to publish to, whose Personal workspace is `personalOf`'s.
// Organizations they aren't in look the same as ones that don't exist.
export async function publishTarget(actor: Actor, key: unknown, personalOf: string): Promise<Workspace> {
  if (key === 'personal') {
    const ws = { userId: personalOf, organizationId: null }
    if (!(await belongsTo(actor, ws))) throw new TransferError("Only the page's owner can move it to their personal workspace.", 403)
    return ws
  }
  if (typeof key !== 'string' || !UUID_RE.test(key)) throw new TransferError('Choose a workspace: personal or one of your organizations.', 400)
  if (actor.blockedOrgs?.includes(key)) {
    throw new TransferError(
      `${(await organizationName(key)) ?? 'This organization'} requires two-factor sign-in. Add a passkey or an authenticator app in your account settings to use it.`,
      403,
      key,
    )
  }
  const ws = { userId: personalOf, organizationId: key }
  if (!(await belongsTo(actor, ws))) throw new TransferError("That workspace doesn't exist, or you aren't a member of it.", 404)
  return ws
}

export function copyTitle(title: string): string {
  return `${title.slice(0, MAX_TITLE_LENGTH - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`
}

// The person must be able to open `source` (checked by the caller, with their link pass if any).
// `title` is already checked (checkTitle); left out, the copy is called "<title> (copy)".
export async function duplicatePage(source: Artifact, actor: Actor, workspace: unknown, opts: { title?: string; clientName?: string | null } = {}) {
  const ws = await publishTarget(actor, workspace, actor.id)
  const title = opts.title ?? copyTitle(source.title)
  const result = await db.transaction(async (tx) => {
    // The copy's rows reference the source's blobs, so the sweep must not remove them before the commit
    await holdStorageLock(tx)
    const [current] = await tx
      .select()
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, source.id), eq(schema.artifactVersions.version, source.currentVersion)))
    // Deleted, or its current version pruned, since the request read it
    if (!current) return null
    const [files] = await tx.execute<{ bytes: number }>(
      sql`select coalesce(sum(size), 0)::float8 as bytes from artifact_files where version_id = ${current.id}`,
    )
    await checkQuota(tx, ws, { page: true, bytes: current.htmlSize + files.bytes, versions: 1 })
    const [created] = await tx
      .insert(schema.artifacts)
      .values({
        slug: newSlug(),
        title,
        ownerId: actor.id,
        organizationId: ws.organizationId,
        visibility: 'private',
        publishedWith: opts.clientName ?? null,
      })
      .returning()
    const [version] = await tx
      .insert(schema.artifactVersions)
      .values({
        artifactId: created.id,
        version: 1,
        htmlSha256: current.htmlSha256,
        htmlSize: current.htmlSize,
        publishedWith: opts.clientName ?? null,
        publishedBy: actor.id,
      })
      .returning({ id: schema.artifactVersions.id })
    await tx.execute(sql`
      insert into artifact_files (version_id, path, content_type, size, sha256)
      select ${version.id}, path, content_type, size, sha256 from artifact_files where version_id = ${current.id}`)
    const copied = await tx.execute(sql`
      insert into artifact_thumbnails (version_id, sha256, content_type)
      select ${version.id}, sha256, content_type from artifact_thumbnails where version_id = ${current.id} and sha256 is not null
      returning version_id`)
    return { created, versionId: version.id, hasThumbnail: [...copied].length > 0 }
  })
  if (!result) throw new TransferError('Not found', 404)
  if (!result.hasThumbnail) queueThumbnail(result.versionId)
  return result.created
}

// Whether this person may move the page out of the workspace it is in: edit access and a place there
export async function canMove(artifact: Artifact, actor: Actor, editable: boolean): Promise<boolean> {
  return editable && (await belongsTo(actor, workspaceOf(artifact)))
}

// The caller has checked canMove. Returns the page as it is now.
export async function movePage(artifact: Artifact, actor: Actor, workspace: unknown): Promise<Artifact> {
  const ws = await publishTarget(actor, workspace, artifact.ownerId)
  if (ws.organizationId === artifact.organizationId) throw new TransferError('The page is already in that workspace.', 400)
  const moved = await db.transaction(async (tx) => {
    // Lock the page, so a publish or another move can't change it between the quota check and the move
    const [locked] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifact.id)).for('update')
    if (!locked) return null
    if (locked.organizationId !== artifact.organizationId) throw new TransferError('The page was moved meanwhile. Reload and try again.', 400)
    const [size] = await tx.execute<{ versions: number; bytes: number }>(sql`
      select
        (select count(*) from artifact_versions where artifact_id = ${artifact.id})::int as versions,
        (select coalesce(sum(html_size), 0) from artifact_versions where artifact_id = ${artifact.id})::float8
          + (select coalesce(sum(f.size), 0) from artifact_files f join artifact_versions v on v.id = f.version_id where v.artifact_id = ${artifact.id})::float8
          as bytes`)
    await checkQuota(tx, ws, { page: true, bytes: size.bytes, versions: size.versions })
    const visibility: Visibility = !ws.organizationId && locked.visibility === 'organization' ? 'private' : locked.visibility
    const [updated] = await tx
      .update(schema.artifacts)
      .set({ organizationId: ws.organizationId, folderId: null, visibility })
      .where(eq(schema.artifacts.id, artifact.id))
      .returning()
    return { before: locked, updated }
  })
  if (!moved) throw new TransferError('Not found', 404)
  const { before, updated } = moved
  const [from, to] = await Promise.all([organizationName(before.organizationId), organizationName(updated.organizationId)])
  const who = { id: actor.id, email: actor.email }
  const visibility = before.visibility !== updated.visibility ? { visibility: { from: before.visibility, to: updated.visibility } } : {}
  // null for the owner's personal workspace
  audit({ action: 'page.moved_out', organizationId: before.organizationId, actor: who, target: pageTarget(updated), details: { to, ...visibility } })
  audit({ action: 'page.moved_in', organizationId: updated.organizationId, actor: who, target: pageTarget(updated), details: { from } })
  return updated
}
