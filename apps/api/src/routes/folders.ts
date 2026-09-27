import { Hono } from 'hono'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db } from '../db/index.js'
import { belongsTo, checkFolderName, createFolder, deleteFolder, FolderError, folderFor, listFolders, renameFolder } from '../folders.js'

export const folders = new Hono<AuthEnv>()

const taken = (name: string) => `There is already a folder called “${name}”.`

function workspaceParam(value: unknown, userId: string) {
  const id = typeof value === 'string' && value ? value : 'personal'
  return { userId, organizationId: id === 'personal' ? null : id }
}

// ?workspace=personal or ?workspace=<organization id>: its folders by name, with how many of the
// pages you see in the gallery are in each
folders.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const ws = workspaceParam(c.req.query('workspace'), user.id)
  if (!(await belongsTo(user.id, ws))) return c.json({ error: 'Not found' }, 404)
  return c.json(await listFolders(ws, user.id))
})

// { workspace, name }
folders.post('/', requireUser, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => ({}))) as { workspace?: unknown; name?: unknown }
  const ws = workspaceParam(body.workspace, user.id)
  if (!(await belongsTo(user.id, ws))) return c.json({ error: 'Not found' }, 404)
  const checked = checkFolderName(body.name)
  if ('error' in checked) return c.json({ error: checked.error, field: 'name' }, 400)
  try {
    const folder = await createFolder(db, ws, checked.name, user.id)
    if (!folder) return c.json({ error: taken(checked.name), field: 'name' }, 409)
    return c.json({ id: folder.id, name: folder.name, pages: 0 }, 201)
  } catch (err) {
    if (err instanceof FolderError) return c.json({ error: err.message, field: 'name' }, 400)
    throw err
  }
})

// { name }
folders.patch('/:id', requireUser, async (c) => {
  const user = c.get('user')!
  const folder = await folderFor(user.id, c.req.param('id'))
  if (!folder) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown }
  const checked = checkFolderName(body.name)
  if ('error' in checked) return c.json({ error: checked.error, field: 'name' }, 400)
  const renamed = await renameFolder(folder, checked.name)
  if (!renamed) return c.json({ error: taken(checked.name), field: 'name' }, 409)
  return c.json({ id: renamed.id, name: renamed.name })
})

// The pages in it stay, in no folder
folders.delete('/:id', requireUser, async (c) => {
  const folder = await folderFor(c.get('user')!.id, c.req.param('id'))
  if (!folder) return c.json({ error: 'Not found' }, 404)
  await deleteFolder(folder)
  return c.body(null, 204)
})
