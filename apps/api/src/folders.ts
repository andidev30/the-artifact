import { and, asc, count, eq, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { canEdit, pagesInWorkspace, type Viewer } from './artifacts.js'
import { db, schema } from './db/index.js'
import type { Artifact, Folder } from './db/schema.js'
import type { Workspace } from './quota.js'
import { UUID_RE } from './validation.js'

// Folders group the pages of one workspace. They are organization only: who can open a page never
// depends on its folder, and people who only have a page shared with them never see its folder.

export const MAX_FOLDER_NAME = 80
export const MAX_FOLDERS = 500

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Queryable = typeof db | Tx

export class FolderError extends Error {}

const f = schema.folders

export function checkFolderName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { error: 'Give the folder a name.' }
  if (name.length > MAX_FOLDER_NAME) return { error: `Keep the folder name under ${MAX_FOLDER_NAME} characters.` }
  return { name }
}

function inWorkspace(ws: Workspace): SQL {
  return ws.organizationId ? eq(f.organizationId, ws.organizationId) : (and(isNull(f.organizationId), eq(f.ownerId, ws.userId)) as SQL)
}

export const workspaceOf = (a: Artifact): Workspace => ({ userId: a.ownerId, organizationId: a.organizationId })

const folderWorkspace = (folder: Folder): Workspace => ({ userId: folder.ownerId ?? '', organizationId: folder.organizationId })

// Anyone who can publish in a workspace organizes its folders: every member of an organization, and
// the person whose personal workspace it is
export async function belongsTo(viewerId: string, ws: Workspace): Promise<boolean> {
  if (!ws.organizationId) return ws.userId === viewerId
  if (!UUID_RE.test(ws.organizationId)) return false
  const [m] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, ws.organizationId), eq(schema.memberships.userId, viewerId)))
  return Boolean(m)
}

// Filing a page changes it, so it takes edit access to the page as well as a place in its workspace.
// Someone a page is shared with from another workspace can't file it: its folders aren't theirs to see.
export async function canFile(artifact: Artifact, viewer: Viewer): Promise<boolean> {
  return (await belongsTo(viewer.id, workspaceOf(artifact))) && (await canEdit(artifact, viewer))
}

// With how many of their pages this person sees in each, counted like the gallery lists them
export async function listFolders(ws: Workspace, viewerId: string) {
  const a = schema.artifacts
  return db
    .select({ id: f.id, name: f.name, pages: count(a.id) })
    .from(f)
    .leftJoin(a, and(eq(a.folderId, f.id), pagesInWorkspace(viewerId, ws.organizationId)))
    .where(inWorkspace(ws))
    .groupBy(f.id)
    .orderBy(asc(sql`lower(${f.name})`), asc(f.id))
}

export async function findFolder(id: string): Promise<Folder | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db.select().from(f).where(eq(f.id, id))
  return row ?? null
}

// A folder the viewer may organize, or null so that missing and someone else's look the same
export async function folderFor(viewerId: string, id: string): Promise<Folder | null> {
  const folder = await findFolder(id)
  return folder && (await belongsTo(viewerId, folderWorkspace(folder))) ? folder : null
}

export async function folderIn(ws: Workspace, id: string): Promise<Folder | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db
    .select()
    .from(f)
    .where(and(eq(f.id, id), inWorkspace(ws)))
  return row ?? null
}

// Names are unique in a workspace whatever their case
export async function folderNamed(q: Queryable, ws: Workspace, name: string): Promise<Folder | null> {
  const [row] = await q
    .select()
    .from(f)
    .where(and(inWorkspace(ws), eq(sql`lower(${f.name})`, name.toLowerCase())))
  return row ?? null
}

// null when the workspace already has a folder by that name
export async function createFolder(q: Queryable, ws: Workspace, name: string, createdBy: string): Promise<Folder | null> {
  const [{ n }] = await q.select({ n: count() }).from(f).where(inWorkspace(ws))
  if (n >= MAX_FOLDERS) throw new FolderError(`A workspace can have up to ${MAX_FOLDERS} folders. Delete one you no longer use first.`)
  const [row] = await q
    .insert(f)
    .values({ organizationId: ws.organizationId, ownerId: ws.organizationId ? null : ws.userId, name, createdBy })
    .onConflictDoNothing()
    .returning()
  return row ?? null
}

// The folder by that name, created when there is none yet
export async function ensureFolder(q: Queryable, ws: Workspace, name: string, createdBy: string): Promise<Folder> {
  const existing = await folderNamed(q, ws, name)
  if (existing) return existing
  // Someone else may create the same name at the same moment; then theirs is the one
  const created = (await createFolder(q, ws, name, createdBy)) ?? (await folderNamed(q, ws, name))
  if (!created) throw new FolderError(`The folder "${name}" could not be created. Try again.`)
  return created
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

// null when another folder in the workspace already has that name
export async function renameFolder(folder: Folder, name: string): Promise<Folder | null> {
  const ws = folderWorkspace(folder)
  const [taken] = await db
    .select({ id: f.id })
    .from(f)
    .where(and(inWorkspace(ws), eq(sql`lower(${f.name})`, name.toLowerCase()), ne(f.id, folder.id)))
  if (taken) return null
  try {
    const [row] = await db.update(f).set({ name }).where(eq(f.id, folder.id)).returning()
    return row
  } catch (err) {
    if (isUniqueViolation(err)) return null
    throw err
  }
}

// Its pages stay where they are, in no folder (the foreign key sets folder_id to null)
export async function deleteFolder(folder: Folder) {
  await db.delete(f).where(eq(f.id, folder.id))
}

// Doesn't touch updated_at: filing a page doesn't change it, and the gallery keeps its order
export async function fileInto(artifact: Artifact, folderId: string | null) {
  await db.update(schema.artifacts).set({ folderId }).where(eq(schema.artifacts.id, artifact.id))
}
