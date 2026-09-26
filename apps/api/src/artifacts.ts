import { randomBytes } from 'node:crypto'
import { and, desc, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import type { Artifact, Visibility } from './db/schema.js'
import { env } from './env.js'

export const MAX_HTML_BYTES = 2 * 1024 * 1024
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function newSlug(): string {
  const bytes = randomBytes(10)
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('')
}

export function artifactUrl(slug: string): string {
  return `${env.appUrl}/a/${slug}`
}

// Accepts a bare slug or a full /a/<slug> link
export function parseArtifactRef(ref: string): string {
  const match = ref.trim().match(/\/a\/([a-z0-9]+)\/?$/)
  return match ? match[1] : ref.trim()
}

async function roleIn(userId: string, organizationId: string) {
  const [m] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationId)))
  return m?.role ?? null
}

// The person asking: pages are shared by email, so both are needed
export type Viewer = { id: string; email: string }

export type Access = 'edit' | 'view' | null

// Like Google Drive: owners and invited editors can edit, invited viewers can view,
// organization admins can edit every page in it, and general access opens a page wider.
export async function accessLevel(artifact: Artifact, viewer: Viewer | null): Promise<Access> {
  let level: Access = artifact.visibility === 'link' ? 'view' : null
  if (!viewer) return level
  if (artifact.ownerId === viewer.id) return 'edit'

  const [share] = await db
    .select({ role: schema.artifactShares.role })
    .from(schema.artifactShares)
    .where(and(eq(schema.artifactShares.artifactId, artifact.id), eq(schema.artifactShares.email, viewer.email.toLowerCase())))
  if (share?.role === 'editor') return 'edit'
  if (share) level = 'view'

  if (artifact.organizationId) {
    const role = await roleIn(viewer.id, artifact.organizationId)
    if (role === 'owner' || role === 'admin') return 'edit'
    if (role && artifact.visibility === 'organization') level = 'view'
  }
  return level
}

export async function canView(artifact: Artifact, viewer: Viewer | null): Promise<boolean> {
  return (await accessLevel(artifact, viewer)) !== null
}

export async function canEdit(artifact: Artifact, viewer: Viewer): Promise<boolean> {
  return (await accessLevel(artifact, viewer)) === 'edit'
}

export async function findBySlug(slug: string) {
  const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
  return row ?? null
}

export async function currentHtml(artifact: Artifact): Promise<string> {
  const [v] = await db
    .select({ html: schema.artifactVersions.html })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, artifact.currentVersion)))
  return v?.html ?? ''
}

type PublishInput = {
  userId: string
  email: string
  organizationId: string | null
  clientName: string
  title: string
  html: string
  slug?: string
  visibility?: Visibility
}

export class PublishError extends Error {}

export async function publish(input: PublishInput): Promise<Artifact> {
  if (Buffer.byteLength(input.html, 'utf8') > MAX_HTML_BYTES) {
    throw new PublishError(`The page is larger than ${MAX_HTML_BYTES / 1024 / 1024} MB. Inline fewer assets or compress images.`)
  }
  const title = input.title.trim().slice(0, 200) || 'Untitled page'

  if (input.slug) {
    const existing = await findBySlug(input.slug)
    if (!existing || !(await canEdit(existing, { id: input.userId, email: input.email }))) {
      throw new PublishError(`No page you can edit has the id "${input.slug}". Publish without artifact_id to create a new page.`)
    }
    if (input.visibility === 'organization' && !existing.organizationId) {
      throw new PublishError('This page is in a personal workspace. Use private or link.')
    }
    return db.transaction(async (tx) => {
      const version = existing.currentVersion + 1
      await tx.insert(schema.artifactVersions).values({ artifactId: existing.id, version, html: input.html, publishedWith: input.clientName, publishedBy: input.userId })
      const [updated] = await tx
        .update(schema.artifacts)
        .set({
          title,
          currentVersion: version,
          updatedAt: new Date(),
          publishedWith: input.clientName,
          ...(input.visibility ? { visibility: input.visibility } : {}),
        })
        .where(eq(schema.artifacts.id, existing.id))
        .returning()
      return updated
    })
  }

  const visibility = input.visibility ?? (input.organizationId ? 'organization' : 'private')
  if (visibility === 'organization' && !input.organizationId) {
    throw new PublishError('Organization visibility needs an organization workspace. Use private or link.')
  }
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.artifacts)
      .values({
        slug: newSlug(),
        title,
        ownerId: input.userId,
        organizationId: input.organizationId,
        visibility,
        publishedWith: input.clientName,
      })
      .returning()
    await tx
      .insert(schema.artifactVersions)
      .values({ artifactId: created.id, version: 1, html: input.html, publishedWith: input.clientName, publishedBy: input.userId })
    return created
  })
}

// Case-insensitive "title contains", with % and _ taken literally
function titleMatches(query: string | undefined): SQL | undefined {
  const q = query?.trim()
  if (!q) return undefined
  return ilike(schema.artifacts.title, `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)
}

// Pages shown in a workspace: in an organization, shared pages plus your own private ones
export async function listForWorkspace(userId: string, organizationId: string | null, limit = 50, query?: string) {
  const scope = organizationId
    ? and(
        eq(schema.artifacts.organizationId, organizationId),
        or(inArray(schema.artifacts.visibility, ['organization', 'link']), eq(schema.artifacts.ownerId, userId)),
      )
    : and(isNull(schema.artifacts.organizationId), eq(schema.artifacts.ownerId, userId))
  const where = and(scope, titleMatches(query))

  return db
    .select({
      artifact: schema.artifacts,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
    })
    .from(schema.artifacts)
    .innerJoin(schema.users, eq(schema.artifacts.ownerId, schema.users.id))
    .where(where)
    .orderBy(desc(schema.artifacts.updatedAt))
    .limit(limit)
}

// Pages other people shared with this email address, newest first
export async function listSharedWith(viewer: Viewer, limit = 50, query?: string) {
  return db
    .select({
      artifact: schema.artifacts,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
      role: schema.artifactShares.role,
    })
    .from(schema.artifactShares)
    .innerJoin(schema.artifacts, eq(schema.artifactShares.artifactId, schema.artifacts.id))
    .innerJoin(schema.users, eq(schema.artifacts.ownerId, schema.users.id))
    .where(and(eq(schema.artifactShares.email, viewer.email.toLowerCase()), titleMatches(query)))
    .orderBy(desc(schema.artifacts.updatedAt))
    .limit(limit)
}

export function describeVisibility(v: Visibility): string {
  if (v === 'private') return 'restricted, so only you and people you add can open it'
  if (v === 'organization') return 'shared with everyone in your organization'
  return 'shared with anyone who has the link'
}

export const MAX_TITLE_LENGTH = 200

// Of these pages, the ids this person can edit, in two queries instead of one per page
export async function editableIds(viewer: Viewer, artifacts: Artifact[]): Promise<Set<string>> {
  const ids = new Set(artifacts.filter((a) => a.ownerId === viewer.id).map((a) => a.id))
  const rest = artifacts.filter((a) => !ids.has(a.id))
  if (rest.length === 0) return ids

  const shares = await db
    .select({ artifactId: schema.artifactShares.artifactId })
    .from(schema.artifactShares)
    .where(
      and(
        inArray(schema.artifactShares.artifactId, rest.map((a) => a.id)),
        eq(schema.artifactShares.email, viewer.email.toLowerCase()),
        eq(schema.artifactShares.role, 'editor'),
      ),
    )
  for (const s of shares) ids.add(s.artifactId)

  const orgIds = [...new Set(rest.map((a) => a.organizationId).filter((id): id is string => id !== null))]
  if (orgIds.length) {
    const admin = await db
      .select({ organizationId: schema.memberships.organizationId })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, viewer.id),
          inArray(schema.memberships.organizationId, orgIds),
          inArray(schema.memberships.role, ['owner', 'admin']),
        ),
      )
    const adminOf = new Set(admin.map((m) => m.organizationId))
    for (const a of rest) if (a.organizationId && adminOf.has(a.organizationId)) ids.add(a.id)
  }
  return ids
}

export async function rename(artifact: Artifact, title: string): Promise<Artifact> {
  const [updated] = await db
    .update(schema.artifacts)
    .set({ title, updatedAt: new Date() })
    .where(eq(schema.artifacts.id, artifact.id))
    .returning()
  return updated
}

// Newest first, without the HTML
export async function listVersions(artifact: Artifact) {
  return db
    .select({
      version: schema.artifactVersions.version,
      createdAt: schema.artifactVersions.createdAt,
      publishedWith: schema.artifactVersions.publishedWith,
      restoredFrom: schema.artifactVersions.restoredFrom,
      publishedByName: schema.users.name,
      publishedByEmail: schema.users.email,
    })
    .from(schema.artifactVersions)
    .leftJoin(schema.users, eq(schema.artifactVersions.publishedBy, schema.users.id))
    .where(eq(schema.artifactVersions.artifactId, artifact.id))
    .orderBy(desc(schema.artifactVersions.version))
}

export async function getVersion(artifact: Artifact, version: number) {
  const [v] = await db
    .select()
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, version)))
  return v ?? null
}

// Restoring never rewrites history: it publishes the old HTML as a new version on top
export async function restoreVersion(artifact: Artifact, version: number, userId: string): Promise<Artifact | null> {
  return db.transaction(async (tx) => {
    // Lock the page so two restores (or a restore and a publish) can't pick the same number
    const [locked] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifact.id)).for('update')
    if (!locked) return null
    const [old] = await tx
      .select({ html: schema.artifactVersions.html })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, version)))
    if (!old) return null
    const next = locked.currentVersion + 1
    await tx
      .insert(schema.artifactVersions)
      .values({ artifactId: artifact.id, version: next, html: old.html, publishedBy: userId, restoredFrom: version })
    const [updated] = await tx
      .update(schema.artifacts)
      .set({ currentVersion: next, updatedAt: new Date() })
      .where(eq(schema.artifacts.id, artifact.id))
      .returning()
    return updated
  })
}
