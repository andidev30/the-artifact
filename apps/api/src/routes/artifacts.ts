import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import {
  auditVisibility,
  canDelete,
  canEdit,
  checkTitle,
  deleteArtifact,
  keyMatches,
  editableIds,
  findBySlug,
  findPageVersion,
  getVersion,
  versionHtml,
  countForWorkspace,
  countSharedWith,
  CursorError,
  listForWorkspace,
  listSharedWith,
  listVersions,
  PublishError,
  recentAccessLevel,
  rename,
  restoreVersion,
} from '../artifacts.js'
import { twoFactorRequiredError } from '../auth/factors.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { commentCounts, type CommentCount } from '../comments.js'
import { belongsTo, canFile, fileInto, folderIn, workspaceOf } from '../folders.js'
import { db, schema } from '../db/index.js'
import { clientIp, hit, limitInvites, limitRequest, refund, tooManyRequests, waitText } from '../limits.js'
import {
  accessFor,
  checkLinkPassword,
  keyLetsIn,
  LinkError,
  linkPassFor,
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
import { compareVersions } from '../compare.js'
import { MAX_VIEWERS, pageViewers, totalViews, versionViews, VIEWER_RETENTION_DAYS } from '../views.js'
import { changeTags, checkTag, TagError, tagsOf } from '../tags.js'
import { parseVersion } from '../validation.js'
import { getSharing, MAX_PEOPLE_PER_INVITE, parseEmails, removePerson, setPersonRole, sharePeople, SharingError } from '../sharing.js'
import { canMove, duplicatePage, movePage, TransferError, workspaceKey } from '../transfer.js'

export const artifacts = new Hono<AuthEnv>()

// ?workspace=personal, ?workspace=<organization id>, or ?workspace=shared for pages shared with you.
// ?q= narrows to pages whose title contains it or whose text has its words; ?folder=<id> or
// ?folder=none to one folder of the workspace; ?tag= to pages with that tag.
// The body is one page of the list, newest first (?limit=, 50 by default, up to 100). X-Next-Cursor
// holds the ?cursor= for the next one and is left out on the last; the first also says X-Total-Count.
artifacts.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const workspace = c.req.query('workspace') ?? 'personal'
  const query = c.req.query('q')?.slice(0, 200)
  const cursor = c.req.query('cursor') || undefined
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
  const tagParam = c.req.query('tag')
  let tag: string | undefined
  if (tagParam !== undefined) {
    const checked = checkTag(tagParam)
    if ('error' in checked) return c.json({ error: checked.error, field: 'tag' }, 400)
    tag = checked.tag
  }

  const headers = (next: string | null, total: number | null) => ({
    ...(next ? { 'X-Next-Cursor': next } : {}),
    ...(total !== null ? { 'X-Total-Count': String(total) } : {}),
  })

  try {
    if (workspace === 'shared') {
      const [{ rows, next }, total] = await Promise.all([
        listSharedWith(user, { query, tag, cursor, limit }),
        cursor ? null : countSharedWith(user, { query, tag }),
      ])
      const [editable, thumbs, counts, tags] = await Promise.all([
        editableIds(
          user,
          rows.map((r) => r.artifact),
        ),
        currentThumbnails(rows.map((r) => r.artifact)),
        commentCounts(
          user.id,
          rows.map((r) => r.artifact.id),
        ),
        tagsOf(rows.map((r) => r.artifact.id)),
      ])
      return c.json(
        rows.map(({ artifact: a, ownerName, ownerEmail, role }) => ({
          ...summary(a, ownerName ?? ownerEmail, thumbs.get(a.id), counts.get(a.id), tags.get(a.id)),
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
      listForWorkspace(user, organizationId, { query, folder, tag, cursor, limit }),
      cursor ? null : countForWorkspace(user, organizationId, { query, folder, tag }),
    ])
    const [editable, thumbs, counts, tags] = await Promise.all([
      editableIds(
        user,
        rows.map((r) => r.artifact),
      ),
      currentThumbnails(rows.map((r) => r.artifact)),
      commentCounts(
        user.id,
        rows.map((r) => r.artifact.id),
      ),
      tagsOf(rows.map((r) => r.artifact.id)),
    ])
    return c.json(
      rows.map(({ artifact: a, ownerName, ownerEmail, folderName }) => ({
        ...summary(a, ownerName ?? ownerEmail, thumbs.get(a.id), counts.get(a.id), tags.get(a.id)),
        mine: a.ownerId === user.id,
        canEdit: editable.has(a.id),
        // Everyone listing a workspace belongs to it, so editors can move its pages elsewhere
        canMove: editable.has(a.id),
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

function summary(a: Artifact, owner: string, thumb: ThumbnailState | undefined, comments: CommentCount | undefined, tags: string[] | undefined) {
  return {
    slug: a.slug,
    title: a.title,
    tags: tags ?? [],
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
  const movable = user ? await canMove(artifact, user, access === 'edit') : false
  const tags = (await tagsOf([artifact.id])).get(artifact.id) ?? []
  return c.json({
    slug: artifact.slug,
    title: artifact.title,
    tags,
    visibility: artifact.visibility,
    version: artifact.currentVersion,
    updatedAt: artifact.updatedAt,
    owner: owner?.name ?? owner?.email ?? null,
    inOrganization: artifact.organizationId !== null,
    canEdit: access === 'edit',
    isOwner: user?.id === artifact.ownerId,
    canMove: movable,
    // 'personal' or the organization's id, for people who belong to it and may move the page
    ...(movable ? { workspace: workspaceKey(artifact.organizationId) } : {}),
    comments: counts ? (counts.get(artifact.id) ?? { total: 0, unread: 0 }) : null,
    views,
    contentUrl: `/api/artifacts/${artifact.slug}/v/${artifact.currentVersion}/`,
  })
})

// The current version's number, which an open page asks for every few seconds to show new versions as
// they are published. Kept cheap: one indexed read of the page row, access from recentAccessLevel, and
// 304 when the version the client has (If-None-Match) is still the current one.
artifacts.get('/:slug/current', async (c) => {
  const artifact = await findBySlug(c.req.param('slug'))
  const access = artifact ? await recentAccessLevel(artifact, c.get('user'), await linkPassFor(c, artifact)) : null
  if (!artifact || !access) return c.json({ error: 'Not found' }, 404, { 'Cache-Control': 'no-store' })
  const etag = `"v${artifact.currentVersion}"`
  const headers = { 'Cache-Control': 'private, no-cache', Vary: 'Cookie', ETag: etag }
  const sent = c.req.header('if-none-match')
  if (sent?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) return c.body(null, 304, headers)
  return c.json({ version: artifact.currentVersion }, 200, headers)
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
  const n = parseVersion(c.req.param('version'))
  if (n === null) return c.json({ error: 'Not found' }, 404)
  const found = await findPageVersion(c.req.param('slug'), n)
  if (!found || !allowed(await accessFor(c, found.artifact), n === found.artifact.currentVersion)) return c.json({ error: 'Not found' }, 404)
  const id = found.version?.id
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
  // Counted before the check, so attempts sent at once can't all be checked; a right one is taken back
  const locked = await hit('link-password', artifact.id)
  if (locked) return tooManyRequests(c, `Too many wrong passwords for this page. Try again in ${waitText(locked)}.`, locked)
  if (!(await verifyPassword(given, artifact.linkPasswordHash))) return c.json({ error: WRONG_LINK_PASSWORD, field: 'password' }, 401)
  await refund('link-password', artifact.id)
  await setGrantCookie(c, artifact)
  return c.body(null, 204)
})

function transferFailed(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof TransferError) {
    return c.json({ error: err.message, ...(err.blockedOrg ? { code: 'two_factor_required' } : {}), ...(err.field ? { field: err.field } : {}) }, err.status)
  }
  // The workspace is full
  if (err instanceof PublishError) return c.json({ error: err.message, field: 'workspace' }, 403)
  throw err
}

// A new page with a copy of the current version, in a workspace this person can publish to
// ({ workspace: 'personal' or an organization id, title? }). Anyone signed in who can open the page.
artifacts.post('/:slug/duplicate', requireUser, async (c) => {
  const user = c.get('user')!
  const artifact = await findBySlug(c.req.param('slug'))
  if (!artifact || !(await accessFor(c, artifact))) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { workspace?: unknown; title?: unknown }
  let title: string | undefined
  if (body.title !== undefined && body.title !== null) {
    const checked = checkTitle(body.title)
    if ('error' in checked) return c.json({ error: checked.error, field: 'title' }, 400)
    title = checked.title
  }
  const busy = await limitRequest(c, 'publish', user.id, 'You have published a lot of pages in a short time.')
  if (busy) return busy
  try {
    const copy = await duplicatePage(artifact, user, body.workspace, { title })
    return c.json({ slug: copy.slug, title: copy.title, visibility: copy.visibility, workspace: workspaceKey(copy.organizationId) }, 201)
  } catch (err) {
    return transferFailed(c, err)
  }
})

// Moves the page to another workspace ({ workspace: 'personal' or an organization id }); see src/transfer.ts
artifacts.post('/:slug/move', requireUser, async (c) => {
  const user = c.get('user')!
  const artifact = await findBySlug(c.req.param('slug'))
  if (!artifact || !(await canMove(artifact, user, await canEdit(artifact, user)))) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { workspace?: unknown }
  try {
    const moved = await movePage(artifact, user, body.workspace)
    return c.json({ slug: moved.slug, visibility: moved.visibility, workspace: workspaceKey(moved.organizationId) })
  } catch (err) {
    return transferFailed(c, err)
  }
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
  if (body.visibility) {
    await db.update(schema.artifacts).set({ visibility: body.visibility }).where(eq(schema.artifacts.id, artifact.id))
    auditVisibility(artifact, body.visibility, c.get('user')!)
  }
  if (folder !== undefined) await fileInto(artifact, folder?.id ?? null)
  if (changesLink) updated = await updateLink(updated, link, c.get('user')!)
  return c.json({
    slug: updated.slug,
    title: updated.title,
    visibility: body.visibility ?? updated.visibility,
    updatedAt: updated.updatedAt,
    link: linkSettings(updated),
    ...(folder !== undefined ? { folder } : {}),
  })
})

// { add: [...], remove: [...] }: removes first, then adds; answers with the page's tags
artifacts.patch('/:slug/tags', requireUser, async (c) => {
  const artifact = await editable(c)
  if (!artifact) return c.json({ error: 'Not found' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { add?: unknown; remove?: unknown }
  try {
    return c.json({ tags: await changeTags(artifact, body) })
  } catch (err) {
    if (err instanceof TagError) return c.json({ error: err.message, field: 'tags' }, 400)
    throw err
  }
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

const versionParam = (c: Context<AuthEnv>) => parseVersion(c.req.param('version'))

artifacts.get('/:slug/versions/:version', requireUser, async (c) => {
  const artifact = await editable(c)
  const n = versionParam(c)
  const v = artifact && n ? await getVersion(artifact, n) : null
  if (!v) return c.json({ error: 'Not found' }, 404)
  return c.json({ version: v.version, createdAt: v.createdAt, html: await versionHtml(v), contentUrl: `/api/artifacts/${artifact!.slug}/v/${v.version}/` })
})

// What changed between two versions (?from=<n>&to=<n>, in either order): the files added, removed and
// changed, with a line diff of the text ones. Editors only, like the history.
artifacts.get('/:slug/compare', requireUser, async (c) => {
  const artifact = await editable(c)
  const from = parseVersion(c.req.query('from'))
  const to = parseVersion(c.req.query('to'))
  if (!artifact || from === null || to === null) return c.json({ error: 'Not found' }, 404)
  const [a, b] = await Promise.all([getVersion(artifact, from), getVersion(artifact, to)])
  if (!a || !b) return c.json({ error: 'Not found' }, 404)
  return c.json(await compareVersions(a, b), 200, { 'Cache-Control': 'private, no-store' })
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
    await setPersonRole(artifact, body.email, body.role, c.get('user')!)
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
  await removePerson(artifact, email, c.get('user')!)
  return c.json(await getSharing(artifact))
})
