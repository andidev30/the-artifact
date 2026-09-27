import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import type { Artifact, Visibility } from './db/schema.js'
import { env } from './env.js'
import { checkHtmlSize, checkManifest, MAX_HTML_BYTES, prepareFiles, PublishError, sha256, type FileInput, type FileMeta, type ManifestEntry } from './files.js'
import { holdStorageLock } from './gc.js'
import { getBlob, getText, putBlob } from './storage.js'
import { checkUploadId, claimUploads } from './uploads.js'
import { queueThumbnail } from './thumbnails.js'

export { MAX_HTML_BYTES, PublishError }
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

// A version's entry HTML, from object storage
export async function versionHtml(v: { htmlSha256: string }): Promise<string> {
  const html = await getText(v.htmlSha256)
  if (html === null) throw new Error(`The HTML of a version is missing from storage (${v.htmlSha256})`)
  return html
}

export async function currentHtml(artifact: Artifact): Promise<string> {
  const v = await getVersion(artifact, artifact.currentVersion)
  return v ? versionHtml(v) : ''
}

// Who publishes, and to which page (a new one without slug)
type PublishTarget = {
  userId: string
  email: string
  organizationId: string | null
  clientName: string
  title: string
  slug?: string
  visibility?: Visibility
}

type PublishInput = PublishTarget & {
  html: string
  // Files next to the entry HTML, referenced by relative paths; each publish sends the full set
  files?: FileInput[]
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// What a version records, and how its bytes get into storage: written by the API for an inline
// publish, or taken over from where the agent uploaded them
type Content = { htmlSha256: string; htmlSize: number; files: FileMeta[]; store: () => Promise<void> }

// Stores a version's content inside the transaction that records it, so the storage sweep can't
// remove a blob between storing it and the commit
async function insertVersion(tx: Tx, values: Omit<typeof schema.artifactVersions.$inferInsert, 'htmlSha256' | 'htmlSize'>, content: Content) {
  await holdStorageLock(tx)
  await content.store()
  const [row] = await tx
    .insert(schema.artifactVersions)
    .values({ ...values, htmlSha256: content.htmlSha256, htmlSize: content.htmlSize })
    .returning({ id: schema.artifactVersions.id })
  if (content.files.length) {
    await tx
      .insert(schema.artifactFiles)
      .values(content.files.map((f) => ({ versionId: row.id, path: f.path, contentType: f.contentType, size: f.size, sha256: f.sha256 })))
  }
  return row.id
}

export async function publish(input: PublishInput): Promise<Artifact> {
  const htmlBytes = Buffer.byteLength(input.html, 'utf8')
  checkHtmlSize(htmlBytes)
  const files = prepareFiles(input.files, htmlBytes)
  const htmlSha256 = sha256(input.html)
  return publishContent(input, {
    htmlSha256,
    htmlSize: htmlBytes,
    files,
    store: async () => {
      await Promise.all([putBlob(input.html, htmlSha256), ...files.map((f) => putBlob(f.content, f.sha256))])
    },
  })
}

// Publishes files the agent uploaded itself after prepare_upload, described again by the same manifest
export async function publishUpload(input: PublishTarget & { uploadId: string; files: ManifestEntry[] }): Promise<Artifact> {
  const { html, files } = checkManifest(input.files)
  checkUploadId(input.uploadId)
  return publishContent(input, { htmlSha256: html.sha256, htmlSize: html.size, files, store: () => claimUploads(input.uploadId, [html, ...files]) })
}

// A rule for creating a page that isn't part of every install, set once by an entry point (src/app.ts
// sets the hosted service's plan limits from ee/). It runs inside the transaction that creates the
// page and refuses it by throwing a PublishError.
export type NewPageCheck = (tx: Tx, owner: { userId: string; organizationId: string | null }) => Promise<void>
let newPageCheck: NewPageCheck | null = null

export function setNewPageCheck(check: NewPageCheck) {
  newPageCheck = check
}

async function publishContent(input: PublishTarget, content: Content): Promise<Artifact> {
  const title = input.title.trim().slice(0, 200) || 'Untitled page'

  if (input.slug) {
    const existing = await findBySlug(input.slug)
    if (!existing || !(await canEdit(existing, { id: input.userId, email: input.email }))) {
      throw new PublishError(`No page you can edit has the id "${input.slug}". Publish without artifact_id to create a new page.`)
    }
    if (input.visibility === 'organization' && !existing.organizationId) {
      throw new PublishError('This page is in a personal workspace. Use private (restricted) or link.')
    }
    const { updated, versionId } = await db.transaction(async (tx) => {
      // Lock the page so two publishes (or a publish and a restore) can't pick the same number
      const [locked] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, existing.id)).for('update')
      const version = locked.currentVersion + 1
      const versionId = await insertVersion(tx, { artifactId: existing.id, version, publishedWith: input.clientName, publishedBy: input.userId }, content)
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
      return { updated, versionId }
    })
    queueThumbnail(versionId)
    return updated
  }

  const visibility = input.visibility ?? (input.organizationId ? 'organization' : 'private')
  if (visibility === 'organization' && !input.organizationId) {
    throw new PublishError('Organization visibility needs an organization workspace. Use private (restricted) or link.')
  }
  const { created, versionId } = await db.transaction(async (tx) => {
    await newPageCheck?.(tx, { userId: input.userId, organizationId: input.organizationId })
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
    const versionId = await insertVersion(tx, { artifactId: created.id, version: 1, publishedWith: input.clientName, publishedBy: input.userId }, content)
    return { created, versionId }
  })
  queueThumbnail(versionId)
  return created
}

// Paths and sizes of a version's files, without their content
export async function listFiles(versionId: string) {
  return db
    .select({ path: schema.artifactFiles.path, size: schema.artifactFiles.size, contentType: schema.artifactFiles.contentType })
    .from(schema.artifactFiles)
    .where(eq(schema.artifactFiles.versionId, versionId))
    .orderBy(asc(schema.artifactFiles.path))
}

const f = schema.artifactFiles
const FILE_META = { path: f.path, contentType: f.contentType, size: f.size, sha256: f.sha256 }

async function withContent<T extends { sha256: string }>(file: T): Promise<T & { content: Buffer }> {
  const content = await getBlob(file.sha256)
  if (!content) throw new Error(`A file is missing from storage (${file.sha256})`)
  return { ...file, content }
}

export async function getFile(versionId: string, path: string) {
  const [file] = await db
    .select(FILE_META)
    .from(f)
    .where(and(eq(f.versionId, versionId), eq(f.path, path)))
  return file ? withContent(file) : null
}

// Everything needed to render a version, e.g. for its thumbnail
export async function loadVersionTree(versionId: string) {
  const [v] = await db.select({ htmlSha256: schema.artifactVersions.htmlSha256 }).from(schema.artifactVersions).where(eq(schema.artifactVersions.id, versionId))
  if (!v) return null
  const files = await db.select(FILE_META).from(f).where(eq(f.versionId, versionId))
  return { html: await versionHtml(v), files: await Promise.all(files.map(withContent)) }
}

// An ILIKE "contains" pattern, with %, _ and \ taken literally
export const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

function titleMatches(query: string | undefined): SQL | undefined {
  const q = query?.trim()
  return q ? ilike(schema.artifacts.title, likeTerm(q)) : undefined
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

// Short labels matching the web app ("Restricted" is stored as private)
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'restricted',
  organization: 'organization',
  link: 'anyone with the link',
}

// The rules for a new page name, shared by the web app and agents. Returns the trimmed title or an error.
export function checkTitle(value: unknown): { title: string } | { error: string } {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) return { error: 'Give the page a name.' }
  if (title.length > MAX_TITLE_LENGTH) return { error: `Keep the name under ${MAX_TITLE_LENGTH} characters.` }
  return { title }
}

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
        inArray(
          schema.artifactShares.artifactId,
          rest.map((a) => a.id),
        ),
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
        and(eq(schema.memberships.userId, viewer.id), inArray(schema.memberships.organizationId, orgIds), inArray(schema.memberships.role, ['owner', 'admin'])),
      )
    const adminOf = new Set(admin.map((m) => m.organizationId))
    for (const a of rest) if (a.organizationId && adminOf.has(a.organizationId)) ids.add(a.id)
  }
  return ids
}

export async function rename(artifact: Artifact, title: string): Promise<Artifact> {
  const [updated] = await db.update(schema.artifacts).set({ title, updatedAt: new Date() }).where(eq(schema.artifacts.id, artifact.id)).returning()
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

// Restoring never rewrites history: it publishes the old HTML and files as a new version on top
export async function restoreVersion(artifact: Artifact, version: number, userId: string): Promise<Artifact | null> {
  const result = await db.transaction(async (tx) => {
    // Lock the page so two restores (or a restore and a publish) can't pick the same number
    const [locked] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, artifact.id)).for('update')
    if (!locked) return null
    await holdStorageLock(tx)
    const [old] = await tx
      .select({ id: schema.artifactVersions.id, htmlSha256: schema.artifactVersions.htmlSha256, htmlSize: schema.artifactVersions.htmlSize })
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, version)))
    if (!old) return null
    const next = locked.currentVersion + 1
    const [created] = await tx
      .insert(schema.artifactVersions)
      .values({ artifactId: artifact.id, version: next, htmlSha256: old.htmlSha256, htmlSize: old.htmlSize, publishedBy: userId, restoredFrom: version })
      .returning({ id: schema.artifactVersions.id })
    // The same files and, when there is one, the same screenshot: new rows for the same blobs
    await tx.execute(sql`
      insert into artifact_files (version_id, path, content_type, size, sha256)
      select ${created.id}, path, content_type, size, sha256 from artifact_files where version_id = ${old.id}`)
    const copied = await tx.execute(sql`
      insert into artifact_thumbnails (version_id, sha256, content_type)
      select ${created.id}, sha256, content_type from artifact_thumbnails where version_id = ${old.id} and sha256 is not null
      returning version_id`)
    const [updated] = await tx
      .update(schema.artifacts)
      .set({ currentVersion: next, updatedAt: new Date() })
      .where(eq(schema.artifacts.id, artifact.id))
      .returning()
    return { updated, versionId: created.id, hasThumbnail: [...copied].length > 0 }
  })
  if (!result) return null
  if (!result.hasThumbnail) queueThumbnail(result.versionId)
  return result.updated
}

// The id of a version, for its files and thumbnail
export async function versionId(artifact: Artifact, version: number): Promise<string | null> {
  const [v] = await db
    .select({ id: schema.artifactVersions.id })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, version)))
  return v?.id ?? null
}
