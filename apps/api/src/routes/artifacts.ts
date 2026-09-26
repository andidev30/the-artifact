import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { accessLevel, canEdit, currentHtml, findBySlug, listForWorkspace, listSharedWith } from '../artifacts.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { ShareRole, Visibility } from '../db/schema.js'
import { getSharing, parseEmails, removePerson, setPersonRole, sharePeople, SharingError } from '../sharing.js'

export const artifacts = new Hono<AuthEnv>()

// ?workspace=personal, ?workspace=<organization id>, or ?workspace=shared for pages shared with you
artifacts.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const workspace = c.req.query('workspace') ?? 'personal'

  if (workspace === 'shared') {
    const rows = await listSharedWith(user)
    return c.json(
      rows
        .filter(({ artifact }) => artifact.ownerId !== user.id)
        .map(({ artifact: a, ownerName, ownerEmail, role }) => ({
          slug: a.slug,
          title: a.title,
          visibility: a.visibility,
          version: a.currentVersion,
          publishedWith: a.publishedWith,
          updatedAt: a.updatedAt,
          owner: ownerName ?? ownerEmail,
          mine: false,
          role,
        })),
    )
  }

  const organizationId = workspace === 'personal' ? null : workspace
  if (organizationId) {
    const [member] = await db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.userId, user.id)))
    if (!member) return c.json({ error: 'Not found' }, 404)
  }
  const rows = await listForWorkspace(user.id, organizationId)
  return c.json(
    rows.map(({ artifact: a, ownerName, ownerEmail }) => ({
      slug: a.slug,
      title: a.title,
      visibility: a.visibility,
      version: a.currentVersion,
      publishedWith: a.publishedWith,
      updatedAt: a.updatedAt,
      owner: ownerName ?? ownerEmail,
      mine: a.ownerId === user.id,
    })),
  )
})

// A page and its current HTML. Pages the viewer can't open look the same as missing ones.
artifacts.get('/:slug', async (c) => {
  const user = c.get('user')
  const artifact = await findBySlug(c.req.param('slug'))
  const access = artifact ? await accessLevel(artifact, user) : null
  if (!artifact || !access) return c.json({ error: 'Not found' }, 404)
  const [owner] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId))
  return c.json({
    slug: artifact.slug,
    title: artifact.title,
    visibility: artifact.visibility,
    version: artifact.currentVersion,
    updatedAt: artifact.updatedAt,
    owner: owner?.name ?? owner?.email ?? null,
    inOrganization: artifact.organizationId !== null,
    canEdit: access === 'edit',
    html: await currentHtml(artifact),
  })
})

// Everything below changes who can open a page, so it needs edit access
async function editable(c: Context<AuthEnv>) {
  const artifact = await findBySlug(c.req.param('slug')!)
  if (!artifact || !(await canEdit(artifact, c.get('user')!))) return null
  return artifact
}

const VISIBILITIES = new Set<Visibility>(['private', 'organization', 'link'])
const ROLES = new Set<ShareRole>(['viewer', 'editor'])

artifacts.patch('/:slug', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { visibility?: Visibility }
  if (!body.visibility || !VISIBILITIES.has(body.visibility)) return c.json({ error: 'Choose restricted, organization or anyone with the link.' }, 400)
  if (body.visibility === 'organization' && !artifact.organizationId) return c.json({ error: 'Personal pages can be restricted or shared by link.' }, 400)
  await db.update(schema.artifacts).set({ visibility: body.visibility }).where(eq(schema.artifacts.id, artifact.id))
  return c.json({ visibility: body.visibility })
})

artifacts.delete('/:slug', requireUser, async (c) => {
  const user = c.get('user')!
  const artifact = await findBySlug(c.req.param('slug'))
  // Only the owner deletes; editors can't remove someone else's page
  if (!artifact || artifact.ownerId !== user.id) return c.json({ error: 'Not found' }, 404)
  await db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifact.id))
  return c.body(null, 204)
})

artifacts.get('/:slug/sharing', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  return c.json(await getSharing(artifact))
})

artifacts.post('/:slug/sharing/people', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { emails?: unknown; role?: ShareRole; notify?: boolean; message?: string }
  const role = body.role && ROLES.has(body.role) ? body.role : 'viewer'
  try {
    const result = await sharePeople(artifact, c.get('user')!, parseEmails(body.emails), role, body.notify !== false, body.message)
    return c.json({ ...result, sharing: await getSharing(artifact) })
  } catch (err) {
    if (err instanceof SharingError) return c.json({ error: err.message }, 400)
    throw err
  }
})

artifacts.patch('/:slug/sharing/people', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: ShareRole }
  if (!body.email || !body.role || !ROLES.has(body.role)) return c.json({ error: 'Choose viewer or editor.' }, 400)
  try {
    await setPersonRole(artifact, body.email, body.role)
    return c.json(await getSharing(artifact))
  } catch (err) {
    if (err instanceof SharingError) return c.json({ error: err.message }, 400)
    throw err
  }
})

artifacts.delete('/:slug/sharing/people', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const email = c.req.query('email')
  if (!email) return c.json({ error: 'Say whose access to remove.' }, 400)
  await removePerson(artifact, email)
  return c.json(await getSharing(artifact))
})
