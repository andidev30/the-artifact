import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
  canDelete,
  canEdit,
  checkTitle,
  deleteArtifact,
  keyMatches,
  editableIds,
  findBySlug,
  getVersion,
  versionHtml,
  countForWorkspace,
  countSharedWith,
  CursorError,
  listForWorkspace,
  listSharedWith,
  listVersions,
  PublishError,
  rename,
  restoreVersion,
  versionId,
} from '../artifacts.js'
import { twoFactorRequiredError } from '../auth/factors.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { commentCounts, type CommentCount } from '../comments.js'
import { belongsTo, canFile, fileInto, folderIn, workspaceOf } from '../folders.js'
import { db, schema } from '../db/index.js'
import { atLimit, clientIp, hit, limitInvites, limitRequest, tooManyRequests, waitText } from '../limits.js'
import {
  accessFor,
  checkLinkPassword,
  keyLetsIn,
  LinkError,
  linkSettings,
  needsPassword,
  parseLinkExpiry,
  setGrantCookie,
  updateLink,
  type LinkChange,
} from '../links.js'
import { verifyPassword } from '../auth/password.js'
import { currentThumbnails, getThumbnail, queueThumbnail, thumbnailsEnabled, type ThumbnailState } from '../thumbnails.js'
import type { Artifact, ShareRole, Visibility } from '../db/schema.js'
import { allowed, downloadVersion, serveVersion } from '../content.js'
import { MAX_VIEWERS, pageViewers, totalViews, versionViews, VIEWER_RETENTION_DAYS } from '../views.js'
import { getSharing, MAX_PEOPLE_PER_INVITE, parseEmails, removePerson, setPersonRole, sharePeople, SharingError } from '../sharing.js'

export const artifacts = new Hono<AuthEnv>()

// ?workspace=personal, ?workspace=<organization id>, or ?workspace=shared for pages shared with you.
// ?q= narrows to titles containing it; ?folder=<id> or ?folder=none to one folder of the workspace.
// The body is one page of the list, newest first (?limit=, 50 by default, up to 100). X-Next-Cursor
// holds the ?cursor= for the next one and is left out on the last; the first also says X-Total-Count.
artifacts.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const workspace = c.req.query('workspace') ?? 'personal'
  const query = c.req.query('q')?.slice(0, 200)
  const cursor = c.req.query('cursor') || undefined
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined

  const headers = (next: string | null, total: number | null) => ({
    ...(next ? { 'X-Next-Cursor': next } : {}),
    ...(total !== null ? { 'X-Total-Count': String(total) } : {}),
  })

  try {
    if (workspace === 'shared') {
      const [{ rows, next }, total] = await Promise.all([listSharedWith(user, { query, cursor, limit }), cursor ? null : countSharedWith(user, query)])
      const [editable, thumbs, counts] = await Promise.all([
        editableIds(
          user,
          rows.map((r) => r.artifact),
        ),
        currentThumbnails(rows.map((r) => r.artifact)),
        commentCounts(
          user.id,
          rows.map((r) => r.artifact.id),
        ),
      ])
      return c.json(
        rows.map(({ artifact: a, ownerName, ownerEmail, role }) => ({
          ...summary(a, ownerName ?? ownerEmail, thumbs.get(a.id), counts.get(a.id)),
          mine: false,
          canEdit: editable.has(a.id),
          role,
        })),
        200,
        headers(next, total),
      )
    }

    const organizationId = workspace === 'personal' ? null : workspace
    const ws = { userId: user.id, organizationId }
    if (organizationId && user.blockedOrgs.includes(organizationId)) return c.json(await twoFactorRequiredError(organizationId), 403)
    if (!(await belongsTo(user, ws))) return c.json({ error: 'Not found' }, 404)
    const folderParam = c.req.query('folder')
    let folder: string | null | undefined
    if (folderParam === 'none') folder = null
    else if (folderParam) {
      if (!(await folderIn(ws, folderParam))) return c.json({ error: 'Not found' }, 404)
      folder = folderParam
    }
    const [{ rows, next }, total] = await Promise.all([
      listForWorkspace(user.id, organizationId, { query, folder, cursor, limit }),
      cursor ? null : countForWorkspace(user.id, organizationId, { query, folder }),
    ])
    const [editable, thumbs, counts] = await Promise.all([
      editableIds(
        user,
        rows.map((r) => r.artifact),
      ),
      currentThumbnails(rows.map((r) => r.artifact)),
      commentCounts(
        user.id,
        rows.map((r) => r.artifact.id),
      ),
    ])
    return c.json(
      rows.map(({ artifact: a, ownerName, ownerEmail, folderName }) => ({
        ...summary(a, ownerName ?? ownerEmail, thumbs.get(a.id), counts.get(a.id)),
        mine: a.ownerId === user.id,
        canEdit: editable.has(a.id),
        folder: a.folderId && folderName ? { id: a.folderId, name: folderName } : null,
      })),
      200,
      headers(next, total),
    )
  } catch (err) {
    if (err instanceof CursorError) return c.json({ error: err.message, field: 'cursor' }, 400)
    throw err
  }
})

function summary(a: Artifact, owner: string, thumb: ThumbnailState | undefined, comments: CommentCount | undefined) {
  return {
    slug: a.slug,
    title: a.title,
    visibility: a.visibility,
    version: a.currentVersion,
    publishedWith: a.publishedWith,
    updatedAt: a.updatedAt,
    owner,
    // thumbnail is kept for older clients; thumbnailState says whether one is still coming
    thumbnail: thumb === 'ready',
    thumbnailState: thumb ?? 'none',
    comments: comments?.total ?? 0,
    // Written by others since this person last opened the page's comments
    unreadComments: comments?.unread ?? 0,
  }
}

// A page's details. Its content is served as a document tree under /v/<version>/.
// Pages the viewer can't open look the same as missing ones.
artifacts.get('/:slug', async (c) => {
  const user = c.get('user')
  const artifact = await findBySlug(c.req.param('slug'))
  const access = artifact ? await accessFor(c, artifact) : null
  const key = c.req.query('k')
  // Only that the link asks for a password: no title, owner or content. An old key is a missing page.
  if (artifact && !access && needsPassword(artifact) && keyMatches(artifact, key))
    return c.json({ error: 'Enter the password to open this page.', field: 'password' }, 401)
  if (!artifact || !access) return c.json({ error: 'Not found' }, 404)
  // The app's next requests for the page (its frame, comments, download) don't carry the key
  if (keyLetsIn(artifact, key)) await setGrantCookie(c, artifact)
  const [owner] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId))
  // Only signed-in people see comments (see routes/comments.ts)
  const counts = user ? await commentCounts(user.id, [artifact.id]) : null
  // Only people who can manage the page see how often it was opened
  const views = access === 'edit' ? await totalViews(artifact) : null
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
    comments: counts ? (counts.get(artifact.id) ?? { total: 0, unread: 0 }) : null,
    views,
    contentUrl: `/api/artifacts/${artifact.slug}/v/${artifact.currentVersion}/`,
  })
})

// The entry and files of one version, with the same access as the page (older versions: editors)
artifacts.get('/:slug/v/:version', (c) => c.redirect(`${new URL(c.req.url).pathname}/`, 301))
artifacts.get('/:slug/v/:version/*', serveVersion)

// A version and its files as one zip, with the same access as viewing it
artifacts.get('/:slug/download', downloadVersion)

// Older link to the current HTML, from before pages were served as a tree
artifacts.get('/:slug/content', async (c) => {
  const artifact = await findBySlug(c.req.param('slug'))
  if (!artifact || !(await accessFor(c, artifact))) return c.text('Not found', 404)
  return c.redirect(`/api/artifacts/${artifact.slug}/v/${artifact.currentVersion}/`, 302)
})

// The screenshot of a version shown on gallery cards. Missing ones are rendered in the background.
artifacts.get('/:slug/thumbnails/:version', async (c) => {
  const artifact = await findBySlug(c.req.param('slug'))
  const n = Number(c.req.param('version'))
  if (!artifact || !Number.isInteger(n) || n < 1) return c.json({ error: 'Not found' }, 404)
  if (!allowed(await accessFor(c, artifact), n === artifact.currentVersion)) return c.json({ error: 'Not found' }, 404)
  const id = await versionId(artifact, n)
  if (!id) return c.json({ error: 'Not found' }, 404)
  const thumb = await getThumbnail(id)
  if (!thumb?.image) {
    if (!thumb && thumbnailsEnabled()) queueThumbnail(id)
    return c.json({ error: 'Not found' }, 404, { 'Cache-Control': 'no-store' })
  }
  const etag = `"${id.slice(0, 8)}-${thumb.createdAt.getTime().toString(36)}"`
  const headers = {
    'Content-Type': thumb.contentType ?? 'image/webp',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
    Vary: 'Cookie',
    ETag: etag,
  }
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
  return c.body(new Uint8Array(thumb.image), 200, headers)
})

const WRONG_LINK_PASSWORD = 'That password is wrong.'

// The password of a link-shared page, with the link's key ({ password, k }). Wrong ones count per page, so guessing from many addresses
// runs into the same limit; every try also counts per address.
artifacts.post('/:slug/unlock', async (c) => {
  const busy = await limitRequest(c, 'link-password-ip', clientIp(c), 'Too many password attempts from your network.')
  if (busy) return busy
  const artifact = await findBySlug(c.req.param('slug'))
  const body = (await c.req.json().catch(() => ({}))) as { password?: unknown; k?: unknown }
  const key = typeof body.k === 'string' ? body.k : null
  if (!artifact || !needsPassword(artifact) || !keyMatches(artifact, key)) return c.json({ error: 'Not found' }, 404)
  const given = typeof body.password === 'string' ? body.password : ''
  if (!given) return c.json({ error: 'Enter the password.', field: 'password' }, 400)
  const locked = await atLimit('link-password', artifact.id)
  if (locked) return tooManyRequests(c, `Too many wrong passwords for this page. Try again in ${waitText(locked)}.`, locked)
  if (!(await verifyPassword(given, artifact.linkPasswordHash))) {
    await hit('link-password', artifact.id)
    return c.json({ error: WRONG_LINK_PASSWORD, field: 'password' }, 401)
  }
  await setGrantCookie(c, artifact)
  return c.body(null, 204)
})

// Everything below changes the page or who can open it, so it needs edit access
async function editable(c: Context<AuthEnv>) {
  const artifact = await findBySlug(c.req.param('slug')!)
  if (!artifact || !(await canEdit(artifact, c.get('user')!))) return null
  return artifact
}

const VISIBILITIES = new Set<Visibility>(['private', 'organization', 'link'])
const ROLES = new Set<ShareRole>(['viewer', 'editor'])

// Rename ({ title }), change general access ({ visibility }), file it ({ folder: <folder id> or null
// for no folder}), or change the link ({ linkExpiresAt: <ISO date> or null, linkPassword: <text> or
// null, rotateLink: true for a new public link }); any of them
artifacts.patch('/:slug', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as {
    visibility?: Visibility
    title?: unknown
    folder?: unknown
    linkExpiresAt?: unknown
    linkPassword?: unknown
    rotateLink?: unknown
  }
  const changesLink = body.linkExpiresAt !== undefined || body.linkPassword !== undefined || body.rotateLink === true
  if (body.title === undefined && body.visibility === undefined && body.folder === undefined && !changesLink)
    return c.json({ error: 'Send a title, a visibility, a folder or link settings.' }, 400)

  const link: LinkChange = { reset: body.rotateLink === true }
  try {
    if (body.linkExpiresAt !== undefined) link.expiresAt = parseLinkExpiry(body.linkExpiresAt)
    if (body.linkPassword !== undefined) link.password = checkLinkPassword(body.linkPassword)
  } catch (err) {
    if (err instanceof LinkError) return c.json({ error: err.message, field: err.field === 'expiresAt' ? 'linkExpiresAt' : 'linkPassword' }, 400)
    throw err
  }

  let title: string | undefined
  if (body.title !== undefined) {
    const checked = checkTitle(body.title)
    if ('error' in checked) return c.json({ error: checked.error, field: 'title' }, 400)
    title = checked.title
  }
  if (body.visibility !== undefined) {
    if (!VISIBILITIES.has(body.visibility)) return c.json({ error: 'Choose restricted, organization or anyone with the link.' }, 400)
    if (body.visibility === 'organization' && !artifact.organizationId) return c.json({ error: 'Personal pages can be restricted or shared by link.' }, 400)
  }
  let folder: { id: string; name: string } | null | undefined
  if (body.folder !== undefined) {
    // Editors from outside the page's workspace get the same answer as a folder that doesn't exist
    if (!(await canFile(artifact, c.get('user')!))) return c.json({ error: 'That folder no longer exists.', field: 'folder' }, 404)
    if (body.folder === null) folder = null
    else {
      const found = typeof body.folder === 'string' ? await folderIn(workspaceOf(artifact), body.folder) : null
      if (!found) return c.json({ error: 'That folder no longer exists.', field: 'folder' }, 404)
      folder = { id: found.id, name: found.name }
    }
  }

  let updated = title !== undefined ? await rename(artifact, title) : artifact
  if (body.visibility) await db.update(schema.artifacts).set({ visibility: body.visibility }).where(eq(schema.artifacts.id, artifact.id))
  if (folder !== undefined) await fileInto(artifact, folder?.id ?? null)
  if (changesLink) updated = await updateLink(updated, link)
  return c.json({
    slug: updated.slug,
    title: updated.title,
    visibility: body.visibility ?? updated.visibility,
    updatedAt: updated.updatedAt,
    link: linkSettings(updated),
    ...(folder !== undefined ? { folder } : {}),
  })
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

// How often each version was opened, and who opened it recently. Editors only, like the history.
artifacts.get('/:slug/views', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const [versions, people] = await Promise.all([versionViews(artifact), pageViewers(artifact, MAX_VIEWERS + 1)])
  return c.json({
    total: versions.reduce((sum, v) => sum + v.views, 0),
    versions,
    people: people
      .slice(0, MAX_VIEWERS)
      .map((p) => ({ name: p.name, email: p.email, visits: p.visits, lastViewedAt: p.lastViewedAt, lastVersion: p.lastVersion })),
    // More people than this opened it; only the most recent are listed
    morePeople: people.length > MAX_VIEWERS,
    keptDays: VIEWER_RETENTION_DAYS,
  })
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
  return c.json({ version: v.version, createdAt: v.createdAt, html: await versionHtml(v), contentUrl: `/api/artifacts/${artifact!.slug}/v/${v.version}/` })
})

artifacts.post('/:slug/versions/:version/restore', requireUser, async (c) => {
  const artifact = await editable(c)
  const n = versionParam(c)
  if (!artifact || !n) return c.json({ error: 'Not found' }, 404)
  if (n === artifact.currentVersion) return c.json({ error: 'This is already the current version.' }, 400)
  let updated: Awaited<ReturnType<typeof restoreVersion>>
  try {
    updated = await restoreVersion(artifact, n, c.get('user')!.id)
  } catch (err) {
    // The workspace is full
    if (err instanceof PublishError) return c.json({ error: err.message }, 403)
    throw err
  }
  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ version: updated.currentVersion, updatedAt: updated.updatedAt })
})

artifacts.delete('/:slug', requireUser, async (c) => {
  const artifact = await findBySlug(c.req.param('slug'))
  if (!artifact || !canDelete(artifact, c.get('user')!)) return c.json({ error: 'Not found' }, 404)
  await deleteArtifact(artifact)
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
  const emails = parseEmails(body.emails)
  const notify = body.notify !== false
  if (notify) {
    const busy = await limitInvites(c, c.get('user')!.id, Math.min(emails.length, MAX_PEOPLE_PER_INVITE))
    if (busy) return busy
  }
  try {
    const result = await sharePeople(artifact, c.get('user')!, emails, role, notify, body.message)
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
