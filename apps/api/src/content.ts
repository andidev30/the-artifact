import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { accessLevel, findBySlug, getFile, getVersion, loadVersionTree, versionHtml, type Viewer } from './artifacts.js'
import type { AuthEnv } from './auth/session.js'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import { env } from './env.js'
import { checkPath, ENTRY_PATH } from './files.js'
import { serverSecret } from './secrets.js'
import { zip } from './zip.js'

// A version is served as a real document tree at /api/artifacts/<slug>/v/<version>/, so the entry
// HTML can load its CSS, JS and images by relative paths.
//
// Pages render in a sandboxed frame with an opaque origin, and browsers don't send the session
// cookie with the requests such a frame makes for its subresources (they count as cross-site).
// So when opening a page needs the viewer's identity, the frame's own navigation, which does carry
// the cookie, is redirected to /v/<version>/~<link token>/, and relative URLs resolve under the
// token. The token names the viewer and expires; access is checked again on every request, so
// removing someone from a page locks them out of its files at once.

export const CONTENT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
// Versions never change; this bounds how long a browser keeps a page someone has since lost access to
const CACHE = 'private, max-age=3600'
export const TOKEN_HOURS = 12
const NAVIGATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object'])

const linkSecret = () => serverSecret('content-links')

function mac(key: Buffer, userId: string, artifactId: string, version: number, expires: number) {
  return createHmac('sha256', key).update(`${userId}|${artifactId}|${version}|${expires}`).digest('base64url').slice(0, 32)
}

// Stable for an hour at a time, so the browser cache keeps working between visits
export async function signContentLink(userId: string, artifact: Artifact, version: number, now = Date.now()): Promise<string> {
  const hour = 3600_000
  const expires = Math.floor(now / hour) * hour + (TOKEN_HOURS + 1) * hour
  const exp = Math.floor(expires / 1000)
  return `${userId.replaceAll('-', '')}.${exp.toString(36)}.${mac(await linkSecret(), userId, artifact.id, version, exp)}`
}

// The user id a link token was issued to, or null when it is forged, for another page or expired
export async function verifyContentLink(token: string, artifact: Artifact, version: number, now = Date.now()): Promise<string | null> {
  const match = token.match(/^([0-9a-f]{32})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{32})$/)
  if (!match) return null
  const hex = match[1]
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  const exp = parseInt(match[2], 36)
  if (exp * 1000 < now) return null
  const expected = Buffer.from(mac(await linkSecret(), userId, artifact.id, version, exp))
  const given = Buffer.from(match[3])
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null
}

async function userById(id: string): Promise<Viewer | null> {
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, id))
  return u ?? null
}

// The current version is for anyone who can open the page; older ones only for its editors,
// like the version history
export function allowed(access: 'edit' | 'view' | null, isCurrent: boolean) {
  return isCurrent ? access !== null : access === 'edit'
}

function notFound(c: Context) {
  return c.text('Not found', 404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
}

// GET /api/artifacts/:slug/v/:version/<path>
export async function serveVersion(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const version = Number(c.req.param('version'))
  if (!Number.isInteger(version) || version < 1) return notFound(c)

  const base = `/api/artifacts/${slug}/v/${version}/`
  const pathname = new URL(c.req.url).pathname
  if (!pathname.startsWith(base)) return notFound(c)
  let rest = pathname.slice(base.length)
  let token: string | null = null
  if (rest.startsWith('~')) {
    const slash = rest.indexOf('/')
    if (slash === -1) return c.redirect(`${pathname}/`, 301)
    token = rest.slice(1, slash)
    rest = rest.slice(slash + 1)
  }
  let path: string
  try {
    path = rest.split('/').map(decodeURIComponent).join('/')
  } catch {
    return notFound(c)
  }
  if (path === '') path = ENTRY_PATH
  else if (!('path' in checkPath(path))) return notFound(c)

  const artifact = await findBySlug(slug)
  if (!artifact || version > artifact.currentVersion) return notFound(c)
  const isCurrent = version === artifact.currentVersion

  let viewer: Viewer | null = c.get('user')
  if (token) {
    const userId = await verifyContentLink(token, artifact, version)
    viewer = userId ? await userById(userId) : null
    if (!viewer) return notFound(c)
  }
  if (!allowed(await accessLevel(artifact, viewer), isCurrent)) return notFound(c)

  // A browser opening a page that needs to know who is looking: continue under a link token
  const needsIdentity = !(isCurrent && artifact.visibility === 'link')
  if (!token && needsIdentity && viewer && NAVIGATIONS.has(c.req.header('sec-fetch-dest') ?? '')) {
    const signed = await signContentLink(viewer.id, artifact, version)
    return c.body(null, 302, { Location: `${base}~${signed}/${rest}${new URL(c.req.url).search}`, 'Cache-Control': 'no-store', Vary: 'Cookie' })
  }

  const v = await getVersion(artifact, version)
  if (!v) return notFound(c)
  let body: Buffer | string
  let contentType: string
  let etag: string
  if (path === ENTRY_PATH) {
    etag = v.htmlSha256.slice(0, 32)
    contentType = 'text/html; charset=utf-8'
    // Unchanged pages revalidate without a trip to storage
    body = c.req.header('if-none-match') === `"${etag}"` ? '' : await versionHtml(v)
  } else {
    const file = await getFile(v.id, path)
    if (!file) return notFound(c)
    body = file.content
    contentType = file.contentType
    etag = file.sha256.slice(0, 32)
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    // Every file, not just HTML: an SVG or HTML file opened on its own is sandboxed too
    'Content-Security-Policy': CONTENT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The sandboxed page has an opaque origin, so its fetch(), module scripts and web fonts are
    // cross-origin requests. "*" never applies to credentialed requests, and a restricted page's
    // files are only reachable under its link token, so this exposes nothing new.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': CACHE,
    ETag: `"${etag}"`,
  }
  if (!token) headers.Vary = 'Cookie'
  if (c.req.header('if-none-match') === `"${etag}"`) return c.body(null, 304, headers)
  return c.body(typeof body === 'string' ? body : new Uint8Array(body), 200, headers)
}

// "Signups by week" → "signups-by-week-v3.zip"; titles with no Latin letters or digits fall back to the page id
function zipName(artifact: Artifact, version: number) {
  const base = artifact.title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${base || artifact.slug}-v${version}.zip`
}

// A download link an agent can fetch without a session. It carries a link token like the sandboxed
// frame's, so it only works for this person and version, and access is checked again when it is used.
export async function downloadLink(userId: string, artifact: Artifact, version: number) {
  const token = await signContentLink(userId, artifact, version)
  return `${env.appUrl}/api/artifacts/${artifact.slug}/download?version=${version}&token=${token}`
}

// GET /api/artifacts/:slug/download[?version=<n>][&token=<link token>]: index.html and every file of a
// version as one zip, with the same access as viewing that version
export async function downloadVersion(c: Context<AuthEnv>) {
  const artifact = await findBySlug(c.req.param('slug')!)
  if (!artifact) return notFound(c)
  const asked = c.req.query('version')
  const version = asked === undefined ? artifact.currentVersion : Number(asked)
  if (!Number.isInteger(version) || version < 1) return notFound(c)

  let viewer: Viewer | null = c.get('user')
  const token = c.req.query('token')
  if (token) {
    const userId = await verifyContentLink(token, artifact, version)
    viewer = userId ? await userById(userId) : null
    if (!viewer) return notFound(c)
  }
  if (!allowed(await accessLevel(artifact, viewer), version === artifact.currentVersion)) return notFound(c)
  const v = await getVersion(artifact, version)
  const tree = v ? await loadVersionTree(v.id) : null
  if (!v || !tree) return notFound(c)

  const archive = zip(
    [{ path: ENTRY_PATH, content: Buffer.from(tree.html, 'utf8') }, ...tree.files.map((f) => ({ path: f.path, content: f.content }))],
    v.createdAt,
  )
  return c.body(new Uint8Array(archive), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${zipName(artifact, version)}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  })
}
