import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm'
import { track } from './analytics.js'
import { audit } from './audit.js'
import { db, schema } from './db/index.js'
import type { Artifact, Visibility } from './db/schema.js'
import { env } from './env.js'
import {
  applyChanges,
  checkManifest,
  checkRemovals,
  ENTRY_PATH,
  MAX_HTML_BYTES,
  PublishError,
  splitEntry,
  type FileInput,
  type FileMeta,
  type ManifestEntry,
  type PageFiles,
} from './files.js'
import { prepare } from './prepare.js'
import { Lru } from './cache.js'
import { belongsTo, checkFolderName, ensureFolder, FolderError } from './folders.js'
import { holdStorageLock } from './gc.js'
import { checkQuota, type Workspace } from './quota.js'
import { getBlob, getText, putBlob } from './storage.js'
import { checkUploadId, claimUploads } from './uploads.js'
import { queueThumbnail } from './thumbnails.js'
import { CONTROL_CHARS_ERROR, hasControlChars, MAX_VERSION, SLUG_RE, UUID_RE } from './validation.js'

export { MAX_HTML_BYTES, PublishError }

// Published on top of a version other than the one the caller started from (base_version)
export class VersionConflictError extends PublishError {}

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function newSlug(): string {
  const bytes = randomBytes(10)
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('')
}

export function artifactUrl(slug: string): string {
  return `${env.appUrl}/a/${slug}`
}

// Accepts a bare slug or a full /a/<slug> link, with or without its ?k= key
export function parseArtifactRef(ref: string): string {
  const match = ref.trim().match(/\/a\/([a-z0-9]+)\/?(?:[?#].*)?$/)
  return match ? match[1] : ref.trim()
}

// Organizations in viewer.blockedOrgs require a second factor this person hasn't set up; there they
// count as not being a member, in the web app, for agents and for content links (src/auth/factors.ts)
async function roleIn(viewer: Viewer, organizationId: string) {
  if (viewer.blockedOrgs?.includes(organizationId)) return null
  const userId = viewer.id
  const [m] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationId)))
  return m?.role ?? null
}

// The person asking: pages are shared by email, so both are needed
export type Viewer = { id: string; email: string; blockedOrgs?: readonly string[] }

export type Access = 'edit' | 'view' | null

// Shared with anyone who has the link, and the link hasn't expired. Its key and password are checked apart.
export function linkOpen(artifact: Artifact, now = new Date()): boolean {
  return artifact.visibility === 'link' && (artifact.linkExpiresAt === null || artifact.linkExpiresAt > now)
}

// The link's key the request carries, or a server-signed grant saying it already passed the link's
// key and password (src/links.ts)
export type LinkPass = { key?: string | null; granted?: boolean }

// A page whose link was never reset has no key: its plain address is the public link, as links shared
// before keys existed are. Compared in constant time.
export function keyMatches(artifact: Artifact, key: string | null | undefined): boolean {
  if (artifact.linkToken === null) return true
  if (!key) return false
  const digest = (v: string) => createHash('sha256').update(v).digest()
  return timingSafeEqual(digest(key), digest(artifact.linkToken))
}

// Whether the link lets this request in: shared by link, not expired, with its key and password
export function linkLetsIn(artifact: Artifact, link: LinkPass = {}): boolean {
  if (!linkOpen(artifact)) return false
  return link.granted === true || (keyMatches(artifact, link.key) && artifact.linkPasswordHash === null)
}

// Like Google Drive: owners and invited editors can edit, invited viewers can view,
// organization admins can edit every page in it, and general access opens a page wider.
export async function accessLevel(artifact: Artifact, viewer: Viewer | null, link: LinkPass = {}): Promise<Access> {
  let level: Access = linkLetsIn(artifact, link) ? 'view' : null
  if (!viewer) return level
  if (artifact.ownerId === viewer.id) return 'edit'

  const [share] = await db
    .select({ role: schema.artifactShares.role })
    .from(schema.artifactShares)
    .where(and(eq(schema.artifactShares.artifactId, artifact.id), eq(schema.artifactShares.email, viewer.email.toLowerCase())))
  if (share?.role === 'editor') return 'edit'
  if (share) level = 'view'

  if (artifact.organizationId) {
    const role = await roleIn(viewer, artifact.organizationId)
    if (role === 'owner' || role === 'admin') return 'edit'
    if (role && artifact.visibility === 'organization') level = 'view'
  }
  return level
}

export async function canView(artifact: Artifact, viewer: Viewer | null, link: LinkPass = {}): Promise<boolean> {
  return (await accessLevel(artifact, viewer, link)) !== null
}

export async function canEdit(artifact: Artifact, viewer: Viewer): Promise<boolean> {
  return (await accessLevel(artifact, viewer)) === 'edit'
}

// Only the owner deletes: editors and organization admins can't remove someone else's page
export function canDelete(artifact: Artifact, viewer: Viewer): boolean {
  return artifact.ownerId === viewer.id
}

// Its versions, files, shares and thumbnails go with it; the storage sweep removes blobs nothing uses any more
export async function deleteArtifact(artifact: Artifact) {
  await db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifact.id))
  forgetPageFiles(artifact.id)
}

export async function findBySlug(slug: string) {
  if (!SLUG_RE.test(slug)) return null
  const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
  return row ?? null
}

export type Version = typeof schema.artifactVersions.$inferSelect

// A page and one of its versions in one query, both read fresh: the page row holds who may open it
// (visibility, the link's key and expiry, the current version, the owner), and the version row says the
// version still exists, which retention, history pruning or deleting the page may have changed on any
// process. The version's files are then read from the cache below. Null when there is no such page;
// version null when the page has no such version.
export async function findPageVersion(slug: string, version: number): Promise<{ artifact: Artifact; version: Version | null } | null> {
  if (!SLUG_RE.test(slug) || !Number.isInteger(version) || version < 1 || version > MAX_VERSION) return null
  const a = schema.artifacts
  const v = schema.artifactVersions
  const [row] = await db
    .select({ artifact: a, version: v })
    .from(a)
    .leftJoin(v, and(eq(v.artifactId, a.id), eq(v.version, version)))
    .where(eq(a.slug, slug))
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
  // As on Viewer
  blockedOrgs?: readonly string[]
  organizationId: string | null
  clientName: string
  // Left out, an existing page keeps its title
  title?: string
  slug?: string
  visibility?: Visibility
  // Name of a folder of the connected workspace to file the page into, created when missing; '' for no folder.
  // Left out, a new page goes in no folder and an existing one stays where it is.
  folder?: string
  // For an existing page: publish only if this is still its current version
  baseVersion?: number
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
  const { html, htmlSha256, htmlSize, files } = await prepare(input.html, input.files)
  return publishContent(input, {
    htmlSha256,
    htmlSize,
    files,
    store: async () => {
      await Promise.all([putBlob(html, htmlSha256), ...files.map((f) => putBlob(f.content, f.sha256))])
    },
  })
}

// Publishes files the agent uploaded itself after prepare_upload, described again by the same manifest
export async function publishUpload(input: PublishTarget & { uploadId: string; files: ManifestEntry[] }): Promise<Artifact> {
  const { html, files } = checkManifest(input.files)
  checkUploadId(input.uploadId)
  return publishContent(input, {
    htmlSha256: html.sha256,
    htmlSize: html.size,
    files,
    store: () => claimUploads(input.uploadId, [html, ...files], input.userId),
  })
}

const ENTRY_TYPE = 'text/html; charset=utf-8'

// The current version's entry and files, read under the page lock
async function currentFiles(tx: Tx, page: Artifact): Promise<PageFiles> {
  const v = schema.artifactVersions
  const [current] = await tx
    .select({ id: v.id, htmlSha256: v.htmlSha256, htmlSize: v.htmlSize })
    .from(v)
    .where(and(eq(v.artifactId, page.id), eq(v.version, page.currentVersion)))
  if (!current) throw new Error(`Version ${page.currentVersion} of page ${page.id} is missing`)
  const files = await tx.select(FILE_META).from(f).where(eq(f.versionId, current.id))
  return { html: { path: ENTRY_PATH, contentType: ENTRY_TYPE, size: current.htmlSize, sha256: current.htmlSha256 }, files }
}

type Changes = { slug: string; remove?: unknown[] }

function checkChanges(input: PublishTarget & Changes, sent: number): string[] {
  if (!input.slug) throw new PublishError('Say which page to update with artifact_id.')
  const remove = checkRemovals(input.remove ?? [])
  if (sent === 0 && remove.length === 0) throw new PublishError('Send at least one file to add or replace, or a path to remove.')
  return remove
}

// A new version of an existing page: its current version with some files added, replaced or removed,
// so a dashboard whose data changes sends only the data. A file named index.html replaces the entry.
// Everything else is as for any publish: checks, limits, quota and history.
export async function updateFiles(input: PublishTarget & Changes & { files?: FileInput[] }): Promise<Artifact> {
  const sent = input.files ?? []
  const remove = checkChanges(input, sent.length)
  const { entry, others } = splitEntry(sent)
  // Without a new entry, '' stands in for it so the other files are still checked and hashed in one go
  const prepared = await prepare(entry ?? '', others)
  const html = entry === undefined ? null : { path: ENTRY_PATH, contentType: ENTRY_TYPE, size: prepared.htmlSize, sha256: prepared.htmlSha256 }
  return publishContent(input, async (tx, page) => {
    const merged = applyChanges(await currentFiles(tx, page), { html, files: prepared.files }, remove)
    return {
      htmlSha256: merged.html.sha256,
      htmlSize: merged.html.size,
      files: merged.files,
      store: async () => {
        await Promise.all([...(html ? [putBlob(prepared.html, html.sha256)] : []), ...prepared.files.map((p) => putBlob(p.content, p.sha256))])
      },
    }
  })
}

// The same with files the agent uploaded itself after prepare_upload. Only the changed files are
// claimed: the ones kept are already stored for the current version.
export async function updateUpload(input: PublishTarget & Changes & { uploadId: string; files: ManifestEntry[] }): Promise<Artifact> {
  const remove = checkChanges(input, input.files.length)
  const { html, files } = checkManifest(input.files, { partial: true })
  checkUploadId(input.uploadId)
  return publishContent(input, async (tx, page) => {
    const merged = applyChanges(await currentFiles(tx, page), { html, files }, remove)
    return {
      htmlSha256: merged.html.sha256,
      htmlSize: merged.html.size,
      files: merged.files,
      store: () => claimUploads(input.uploadId, html ? [html, ...files] : files, input.userId),
    }
  })
}

// undefined: leave the folder as it is; null: no folder
function folderChoice(folder: string | undefined): string | null | undefined {
  if (folder === undefined) return undefined
  if (!folder.trim()) return null
  const checked = checkFolderName(folder)
  if ('error' in checked) throw new PublishError(checked.error)
  return checked.name
}

async function folderId(tx: Tx, ws: Workspace, name: string | null, userId: string): Promise<string | null> {
  if (name === null) return null
  try {
    return (await ensureFolder(tx, ws, name, userId)).id
  } catch (err) {
    if (err instanceof FolderError) throw new PublishError(err.message)
    throw err
  }
}

const contentSize = (content: Content) => content.htmlSize + content.files.reduce((sum, f) => sum + f.size, 0)

// content is a function for an update, whose content depends on the current version: it runs under the page's lock
async function publishContent(input: PublishTarget, content: Content | ((tx: Tx, page: Artifact) => Promise<Content>)): Promise<Artifact> {
  if (input.title !== undefined && hasControlChars(input.title)) throw new PublishError("The title can't contain control characters.")
  const title = input.title === undefined ? undefined : input.title.trim().slice(0, 200) || 'Untitled page'
  const folder = folderChoice(input.folder)

  if (input.slug) {
    const existing = await findBySlug(input.slug)
    const viewer = { id: input.userId, email: input.email, blockedOrgs: input.blockedOrgs }
    if (!existing || !(await canEdit(existing, viewer))) {
      throw new PublishError(
        typeof content === 'function'
          ? `No page you can edit has the id "${input.slug}".`
          : `No page you can edit has the id "${input.slug}". Publish without artifact_id to create a new page.`,
      )
    }
    if (input.visibility === 'organization' && !existing.organizationId) {
      throw new PublishError('This page is in a personal workspace. Use private (restricted) or link.')
    }
    const ws = { userId: existing.ownerId, organizationId: existing.organizationId }
    // Folder names are looked up in the connected workspace, so a page from elsewhere (shared with
    // this person) can't be filed from here
    if (folder !== undefined && (existing.organizationId !== input.organizationId || !(await belongsTo(viewer, ws)))) {
      throw new PublishError("This page belongs to another workspace, so it can't be filed into a folder from here. Publish again without folder.")
    }
    const { updated, versionId } = await db.transaction(async (tx) => {
      // Lock the page so two publishes (or a publish and a restore) can't pick the same number
      const [locked] = await tx.select().from(schema.artifacts).where(eq(schema.artifacts.id, existing.id)).for('update')
      if (input.baseVersion !== undefined && input.baseVersion !== locked.currentVersion) {
        throw new VersionConflictError(
          `This page is at version ${locked.currentVersion}, not ${input.baseVersion}: someone published a new version since. ` +
            'Read the current version, apply your changes to it, and send its number as base_version.',
        )
      }
      const built = typeof content === 'function' ? await content(tx, locked) : content
      await checkQuota(tx, { userId: locked.ownerId, organizationId: locked.organizationId }, { page: false, bytes: contentSize(built) })
      const version = locked.currentVersion + 1
      const versionId = await insertVersion(tx, { artifactId: existing.id, version, publishedWith: input.clientName, publishedBy: input.userId }, built)
      const filed = folder === undefined ? {} : { folderId: await folderId(tx, ws, folder, input.userId) }
      const [updated] = await tx
        .update(schema.artifacts)
        .set({
          ...(title === undefined ? {} : { title }),
          currentVersion: version,
          updatedAt: new Date(),
          publishedWith: input.clientName,
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...filed,
        })
        .where(eq(schema.artifacts.id, existing.id))
        .returning()
      return { updated, versionId }
    })
    queueThumbnail(versionId)
    track({ event: 'page_published', userId: input.userId })
    if (input.visibility) auditVisibility(existing, input.visibility, { id: input.userId, email: input.email })
    return updated
  }

  if (typeof content === 'function') throw new PublishError('Say which page to update with artifact_id.')
  const visibility = input.visibility ?? (input.organizationId ? 'organization' : 'private')
  if (visibility === 'organization' && !input.organizationId) {
    throw new PublishError('Organization visibility needs an organization workspace. Use private (restricted) or link.')
  }
  const { created, versionId } = await db.transaction(async (tx) => {
    const ws = { userId: input.userId, organizationId: input.organizationId }
    await checkQuota(tx, ws, { page: true, bytes: contentSize(content) })
    const [created] = await tx
      .insert(schema.artifacts)
      .values({
        slug: newSlug(),
        title: title ?? 'Untitled page',
        ownerId: input.userId,
        organizationId: input.organizationId,
        visibility,
        publishedWith: input.clientName,
        folderId: await folderId(tx, ws, folder ?? null, input.userId),
      })
      .returning()
    const versionId = await insertVersion(tx, { artifactId: created.id, version: 1, publishedWith: input.clientName, publishedBy: input.userId }, content)
    return { created, versionId }
  })
  queueThumbnail(versionId)
  track({ event: 'page_published', userId: input.userId })
  // A new page in an organization is open to it by default, which nobody chose, so only a link counts
  if (visibility === 'link') track({ event: 'page_shared', userId: input.userId, detail: 'link' })
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
type StoredFile = { path: string; contentType: string; size: number; sha256: string }

// The files of recently served versions, by version id: every viewer of a page loads the same ones.
// A version's files never change once it is written and the id is never reused, so an entry can only
// go out of date by the version being deleted. Every lookup passes a version row the request has just
// read from the database (findPageVersion, getVersion), so a version deleted on another process is
// never served from here; deletes on this process also drop their entries, and the rest age out.
type VersionFiles = { artifactId: string; files: Map<string, StoredFile> }
const FILE_CACHE_VERSIONS = 5000
const FILE_CACHE_BYTES = 16 * 1024 * 1024
const fileCache = new Lru<string, VersionFiles>(FILE_CACHE_VERSIONS, FILE_CACHE_BYTES, (entry) => {
  // A rough size: the strings plus the Map's and objects' overhead
  let bytes = 200
  for (const file of entry.files.values()) bytes += 150 + 2 * (file.path.length + file.contentType.length + file.sha256.length)
  return bytes
})

async function versionFiles(v: { id: string; artifactId: string }): Promise<Map<string, StoredFile>> {
  const hit = fileCache.get(v.id)
  if (hit) return hit.files
  const rows = await db.select(FILE_META).from(f).where(eq(f.versionId, v.id))
  const files = new Map(rows.map((row) => [row.path, row]))
  fileCache.set(v.id, { artifactId: v.artifactId, files })
  return files
}

export function forgetVersionFiles(versionIds: Iterable<string>) {
  for (const id of versionIds) fileCache.delete(id)
}

function forgetPageFiles(artifactId: string) {
  fileCache.deleteWhere((entry) => entry.artifactId === artifactId)
}

// For tests
export function clearFileCache() {
  fileCache.clear()
}

async function withContent<T extends { sha256: string }>(file: T): Promise<T & { content: Buffer }> {
  const content = await getBlob(file.sha256)
  if (!content) throw new Error(`A file is missing from storage (${file.sha256})`)
  return { ...file, content }
}

// `v` must have been read from the database by this request (see the file cache above)
export async function getFile(v: { id: string; artifactId: string }, path: string) {
  const file = (await versionFiles(v)).get(path)
  return file ? withContent(file) : null
}

// Everything needed to render a version, e.g. for a download; `v` read fresh as for getFile
export async function loadVersionTree(v: { id: string; artifactId: string; htmlSha256: string }) {
  const files = [...(await versionFiles(v)).values()]
  return { html: await versionHtml(v), files: await Promise.all(files.map(withContent)) }
}

// An ILIKE "contains" pattern, with %, _ and \ taken literally
// Postgres text can't hold NUL, and nothing stored contains one
export const likeTerm = (q: string) => `%${q.replaceAll('\0', '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

function titleMatches(query: string | undefined): SQL | undefined {
  const q = query?.trim()
  return q ? ilike(schema.artifacts.title, likeTerm(q)) : undefined
}

// Pages shown in a workspace: in an organization, shared pages plus your own private ones
export function pagesInWorkspace(userId: string, organizationId: string | null): SQL {
  const a = schema.artifacts
  return (
    organizationId
      ? and(eq(a.organizationId, organizationId), or(inArray(a.visibility, ['organization', 'link']), eq(a.ownerId, userId)))
      : and(isNull(a.organizationId), eq(a.ownerId, userId))
  ) as SQL
}

export const PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

// A list is read newest first, one page at a time. folder: undefined for every page, null for pages
// in no folder, or a folder id. cursor: the next value of the page before.
export type ListOptions = { limit?: number; query?: string; folder?: string | null; cursor?: string }

export class CursorError extends Error {
  constructor() {
    super('This list changed while you were reading it. Start again from the first page.')
  }
}

// The cursor is the (updated_at, id) of the last row: stable while pages are added or updated, since
// a page that moves to the top only shows up on a new first page. updated_at goes through as text
// with every microsecond, which a JavaScript Date would round to milliseconds and so skip or repeat rows.
const CURSOR_AT = sql<string>`to_char(${schema.artifacts.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url')

function after(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined
  const [at = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (!CURSOR_RE.test(at) || !UUID_RE.test(id)) throw new CursorError()
  return sql`(${schema.artifacts.updatedAt}, ${schema.artifacts.id}) < (${at}::timestamptz, ${id}::uuid)`
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)))
}

// Rows one past the limit say whether there is a next page
function paged<T extends { cursorAt: string; artifact: Artifact }>(rows: T[], limit: number) {
  if (rows.length <= limit) return { rows, next: null }
  const last = rows[limit - 1]
  return { rows: rows.slice(0, limit), next: encodeCursor(last.cursorAt, last.artifact.id) }
}

function inFolder(folder: string | null | undefined): SQL | undefined {
  if (folder === undefined) return undefined
  return folder === null ? isNull(schema.artifacts.folderId) : eq(schema.artifacts.folderId, folder)
}

const NEWEST_FIRST = [desc(schema.artifacts.updatedAt), desc(schema.artifacts.id)]

export async function listForWorkspace(userId: string, organizationId: string | null, opts: ListOptions = {}) {
  const limit = pageLimit(opts.limit)
  const rows = await db
    .select({
      artifact: schema.artifacts,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
      folderName: schema.folders.name,
      cursorAt: CURSOR_AT,
    })
    .from(schema.artifacts)
    .innerJoin(schema.users, eq(schema.artifacts.ownerId, schema.users.id))
    .leftJoin(schema.folders, eq(schema.artifacts.folderId, schema.folders.id))
    .where(and(pagesInWorkspace(userId, organizationId), titleMatches(opts.query), inFolder(opts.folder), after(opts.cursor)))
    .orderBy(...NEWEST_FIRST)
    .limit(limit + 1)
  return paged(rows, limit)
}

export async function countForWorkspace(userId: string, organizationId: string | null, opts: Pick<ListOptions, 'query' | 'folder'> = {}) {
  const [row] = await db
    .select({ n: count() })
    .from(schema.artifacts)
    .where(and(pagesInWorkspace(userId, organizationId), titleMatches(opts.query), inFolder(opts.folder)))
  return row.n
}

// Pages other people shared with this email address. Their folders belong to the owner's workspace, so they aren't part of it.
function sharedWith(viewer: Viewer, query: string | undefined): SQL {
  return and(eq(schema.artifactShares.email, viewer.email.toLowerCase()), ne(schema.artifacts.ownerId, viewer.id), titleMatches(query)) as SQL
}

export async function listSharedWith(viewer: Viewer, opts: Omit<ListOptions, 'folder'> = {}) {
  const limit = pageLimit(opts.limit)
  const rows = await db
    .select({
      artifact: schema.artifacts,
      ownerName: schema.users.name,
      ownerEmail: schema.users.email,
      role: schema.artifactShares.role,
      cursorAt: CURSOR_AT,
    })
    .from(schema.artifactShares)
    .innerJoin(schema.artifacts, eq(schema.artifactShares.artifactId, schema.artifacts.id))
    .innerJoin(schema.users, eq(schema.artifacts.ownerId, schema.users.id))
    .where(and(sharedWith(viewer, opts.query), after(opts.cursor)))
    .orderBy(...NEWEST_FIRST)
    .limit(limit + 1)
  return paged(rows, limit)
}

export async function countSharedWith(viewer: Viewer, query?: string) {
  const [row] = await db
    .select({ n: count() })
    .from(schema.artifactShares)
    .innerJoin(schema.artifacts, eq(schema.artifactShares.artifactId, schema.artifacts.id))
    .where(sharedWith(viewer, query))
  return row.n
}

// For the audit log of the page's organization
export const pageTarget = (a: Pick<Artifact, 'slug' | 'title'>) => ({ type: 'page' as const, id: a.slug, label: a.title })

// Also the hosted service's funnel step of a first share, when the page opens wider than restricted
export function auditVisibility(artifact: Artifact, to: Visibility, actor: { id: string; email: string }) {
  if (to === artifact.visibility) return
  if (to !== 'private') track({ event: 'page_shared', userId: actor.id, detail: to })
  audit({
    action: 'page.visibility_changed',
    organizationId: artifact.organizationId,
    actor,
    target: pageTarget(artifact),
    details: { from: artifact.visibility, to },
  })
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
  if (hasControlChars(title)) return { error: CONTROL_CHARS_ERROR }
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

  const orgIds = [...new Set(rest.map((a) => a.organizationId).filter((id): id is string => id !== null && !viewer.blockedOrgs?.includes(id)))]
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
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) return null
  const [v] = await db
    .select()
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifact.id), eq(schema.artifactVersions.version, version)))
  return v ?? null
}

// Restoring never rewrites history: it publishes the old HTML and files as a new version on top
export async function restoreVersion(artifact: Artifact, version: number, userId: string): Promise<Artifact | null> {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) return null
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
    const [files] = await tx.execute<{ bytes: number }>(sql`select coalesce(sum(size), 0)::float8 as bytes from artifact_files where version_id = ${old.id}`)
    await checkQuota(tx, { userId: locked.ownerId, organizationId: locked.organizationId }, { page: false, bytes: old.htmlSize + files.bytes })
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
