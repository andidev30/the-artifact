import { Hono } from 'hono'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { belongsTo } from '../folders.js'
import { workspaceTags } from '../tags.js'

export const tags = new Hono<AuthEnv>()

// ?workspace=personal or ?workspace=<organization id>: the tags of the pages you see in its gallery,
// by name, with how many pages have each
tags.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const id = c.req.query('workspace') || 'personal'
  const ws = { userId: user.id, organizationId: id === 'personal' ? null : id }
  if (!(await belongsTo(user, ws))) return c.json({ error: 'Not found' }, 404)
  return c.json(await workspaceTags(ws, user))
})
