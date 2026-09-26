import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
  accessLevel,
  canEdit,
  currentHtml,
  editableIds,
  findBySlug,
  getVersion,
  listForWorkspace,
  listSharedWith,
  listVersions,
  MAX_TITLE_LENGTH,
  rename,
  restoreVersion,
} from '../artifacts.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { ShareRole, Visibility } from '../db/schema.js'
import { getSharing, parseEmails, removePerson, setPersonRole, sharePeople, SharingError } from '../sharing.js'

export const artifacts = new Hono<AuthEnv>()

// ?workspace=personal, ?workspace=<organization id>, or ?workspace=shared for pages shared with you.
// ?q= narrows to titles containing it.
artifacts.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const workspace = c.req.query('workspace') ?? 'personal'
  const query = c.req.query('q')?.slice(0, 200)

  if (workspace === 'shared') {
    const rows = (await listSharedWith(user, 50, query)).filter(({ artifact }) => artifact.ownerId !== user.id)
    const editable = await editableIds(user, rows.map((r) => r.artifact))
    return c.json(
      rows.map(({ artifact: a, ownerName, ownerEmail, role }) => ({
          slug: a.slug,
          title: a.title,
          visibility: a.visibility,
          version: a.currentVersion,
          publishedWith: a.publishedWith,
          updatedAt: a.updatedAt,
          owner: ownerName ?? ownerEmail,
          mine: false,
          canEdit: editable.has(a.id),
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
  const rows = await listForWorkspace(user.id, organizationId, 50, query)
  const editable = await editableIds(user, rows.map((r) => r.artifact))
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
      canEdit: editable.has(a.id),
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
    isOwner: user?.id === artifact.ownerId,
    html: await currentHtml(artifact),
  })
})

// The current HTML as a document of its own, for gallery thumbnails. The CSP sandbox gives it an
// opaque origin even when opened directly, so its scripts can't read cookies or call this API.
artifacts.get('/:slug/content', async (c) => {
  const artifact = await findBySlug(c.req.param('slug'))
  if (!artifact || !(await accessLevel(artifact, c.get('user')))) return c.text('Not found', 404)
  return c.body(await currentHtml(artifact), 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': 'sandbox allow-scripts',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Private to this browser; the gallery adds ?v=<version> so a new version is fetched fresh
    'Cache-Control': 'private, max-age=300',
    Vary: 'Cookie',
  })
})

// Everything below changes the page or who can open it, so it needs edit access
async function editable(c: Context<AuthEnv>) {
  const artifact = await findBySlug(c.req.param('slug')!)
  if (!artifact || !(await canEdit(artifact, c.get('user')!))) return null
  return artifact
}

const VISIBILITIES = new Set<Visibility>(['private', 'organization', 'link'])
const ROLES = new Set<ShareRole>(['viewer', 'editor'])

// Rename ({ title }) or change general access ({ visibility }); either or both
artifacts.patch('/:slug', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { visibility?: Visibility; title?: unknown }
  if (body.title === undefined && body.visibility === undefined) return c.json({ error: 'Send a title or a visibility.' }, 400)

  let title: string | undefined
  if (body.title !== undefined) {
    title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: 'Give the page a name.', field: 'title' }, 400)
    if (title.length > MAX_TITLE_LENGTH) return c.json({ error: `Keep the name under ${MAX_TITLE_LENGTH} characters.`, field: 'title' }, 400)
  }
  if (body.visibility !== undefined) {
    if (!VISIBILITIES.has(body.visibility)) return c.json({ error: 'Choose restricted, organization or anyone with the link.' }, 400)
    if (body.visibility === 'organization' && !artifact.organizationId) return c.json({ error: 'Personal pages can be restricted or shared by link.' }, 400)
  }

  const updated = title !== undefined ? await rename(artifact, title) : artifact
  if (body.visibility) await db.update(schema.artifacts).set({ visibility: body.visibility }).where(eq(schema.artifacts.id, artifact.id))
  return c.json({ title: updated.title, visibility: body.visibility ?? updated.visibility, updatedAt: updated.updatedAt })
})

// Version history is for editors only: older versions can hold things the author deliberately
// removed, and people who can only view should see what is published now (Drive does the same)
artifacts.get('/:slug/versions', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const rows = await listVersions(artifact)
  return c.json(
    rows.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      publishedWith: v.publishedWith,
      publishedBy: v.publishedByName ?? v.publishedByEmail ?? null,
      restoredFrom: v.restoredFrom,
      current: v.version === artifact.currentVersion,
    })),
  )
})

function versionParam(c: Context<AuthEnv>): number | null {
  const n = Number(c.req.param('version'))
  return Number.isInteger(n) && n > 0 ? n : null
}

artifacts.get('/:slug/versions/:version', requireUser, async (c) => {
  const artifact = await editable(c)
  const n = versionParam(c)
  const v = artifact && n ? await getVersion(artifact, n) : null
  if (!v) return c.json({ error: 'Not found' }, 404)
  return c.json({ version: v.version, createdAt: v.createdAt, html: v.html })
})

artifacts.post('/:slug/versions/:version/restore', requireUser, async (c) => {
  const artifact = await editable(c)
  const n = versionParam(c)
  if (!artifact || !n) return c.json({ error: 'Not found' }, 404)
  if (n === artifact.currentVersion) return c.json({ error: 'This is already the current version.' }, 400)
  const updated = await restoreVersion(artifact, n, c.get('user')!.id)
  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ version: updated.currentVersion, updatedAt: updated.updatedAt })
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
