import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { accessLevel, findBySlug, getFile, getVersion, linkLetsIn, linkOpen, loadVersionTree, versionHtml, type LinkPass, type Viewer } from './artifacts.js'
import type { AuthEnv } from './auth/session.js'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import { env } from './env.js'
import { checkPath, ENTRY_PATH } from './files.js'
import { clientIp } from './limits.js'
import { isGrant, linkPassFor, signGrant, verifyGrant } from './links.js'
import { onUnhandledError } from './metrics.js'
import { serverSecret } from './secrets.js'
import { recordView } from './views.js'
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
//
// With CONTENT_ORIGIN, the files are served only from that origin, another site than the app's, so
// even a page that escaped its sandbox runs where the browser never sends the app's cookies. The same
// server answers both hosts. On the app's host a request for a page's files is checked with the
// session, the link's key and the grant cookie as before, then redirected to the content origin under
// a link token (or none, for a plain link-shared page). The content host serves nothing but these
// files, never reads a cookie and never sets one: a token or the link's key in the URL is the only way in.

const CONTENT_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

// Pages are framed by the app's viewer and by embeds (/e/<slug>) on other sites, so they may be framed
// wherever embeds may; the sandbox is what keeps them from reaching anything. With no allowlist there is
// no frame-ancestors at all rather than "*", which doesn't match a sandboxed or data: ancestor (no origin).
// On a content origin, 'self' is that origin, so the app's own origin is listed as well.
export function contentCsp() {
  if (!env.embedFrameAncestors) return CONTENT_SANDBOX
  const ancestors = env.contentOrigin ? `${env.embedFrameAncestors} ${new URL(env.appUrl).origin}` : env.embedFrameAncestors
  return `${CONTENT_SANDBOX}; frame-ancestors ${ancestors}`
}

// The host the browser asked for. Behind TRUST_PROXY proxies, the one the outermost of them saw, as
// clientAddress in limits.ts reads X-Forwarded-For; Node and Vercel build the request URL from Host.
export function requestHost(c: Context): string {
  if (env.trustProxy > 0) {
    const hops = (c.req.header('x-forwarded-host') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const host = hops[Math.max(0, hops.length - env.trustProxy)]
    if (host) return host.toLowerCase()
  }
  return new URL(c.req.url).host.toLowerCase()
}

// Whether this request came in on CONTENT_ORIGIN. Anything else (the app's host, an address a health
// probe uses) is treated as the app.
export function onContentHost(c: Context): boolean {
  if (!env.contentOrigin) return false
  const content = new URL(env.contentOrigin)
  try {
    return new URL(`${content.protocol}//${requestHost(c)}`).host === content.host
  } catch {
    return false
  }
}

// Versions never change; this bounds how long a browser keeps a page someone has since lost access to
const CACHE = 'private, max-age=3600'
// The entry HTML is checked again on every open, so each visit reaches the server and can be counted
// as a view; an unchanged page still gets a 304 without a trip to storage
const ENTRY_CACHE = 'private, no-cache'
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

  // The content host has no session middleware, so no user; it doesn't read the grant cookie either
  const onContent = onContentHost(c)
  let viewer: Viewer | null = c.get('user') ?? null
  let link: LinkPass = {}
  if (token && isGrant(token)) {
    // Someone who passed the link's key and password, whoever they are
    if (!(await verifyGrant(token, artifact))) return notFound(c)
    viewer = null
    link = { granted: true }
  } else if (token) {
    const userId = await verifyContentLink(token, artifact, version)
    viewer = userId ? await userById(userId) : null
    if (!viewer) return notFound(c)
  } else if (onContent) {
    link = { key: c.req.query('k') ?? null }
  } else {
    link = await linkPassFor(c, artifact)
  }
  const access = await accessLevel(artifact, viewer, link)
  if (!allowed(access, isCurrent)) return notFound(c)

  // People with access of their own get a token naming them, which outlives a reset or a new password;
  // others one saying they gave the link's key and password
  const sign = async () => {
    const own = viewer ? await accessLevel(artifact, viewer) : null
    return viewer && own ? await signContentLink(viewer.id, artifact, version) : linkLetsIn(artifact, link) ? (await signGrant(artifact)).token : null
  }
  const plainLink = linkOpen(artifact) && artifact.linkToken === null && artifact.linkPasswordHash === null
  const query = new URL(c.req.url).searchParams

  // Nothing of a page is served on the app's host when there is a content origin
  if (env.contentOrigin && !onContent) {
    let prefix = base
    if (token) prefix = `${base}~${token}/`
    else if (!(isCurrent && plainLink)) {
      const signed = await sign()
      if (!signed) return notFound(c)
      prefix = `${base}~${signed}/`
      query.delete('k')
    }
    const search = query.size ? `?${query}` : ''
    return c.body(null, 302, { Location: `${env.contentOrigin}${prefix}${rest}${search}`, 'Cache-Control': 'no-store', Vary: 'Cookie' })
  }

  // A browser opening a page that needs to know who is looking, or that the link's key and password
  // were given: continue under a token
  if (!token && !(isCurrent && plainLink) && NAVIGATIONS.has(c.req.header('sec-fetch-dest') ?? '')) {
    const signed = await sign()
    if (signed) {
      query.delete('k')
      const search = query.size ? `?${query}` : ''
      return c.body(null, 302, { Location: `${base}~${signed}/${rest}${search}`, 'Cache-Control': 'no-store', ...(onContent ? {} : { Vary: 'Cookie' }) })
    }
  }

  const v = await getVersion(artifact, version)
  if (!v) return notFound(c)
  // A browser opening the page, not one of its files. Runs next to the storage read and is awaited
  // before answering, so serverless hosts don't cut it off.
  const opened =
    path === ENTRY_PATH && c.req.method === 'GET' && NAVIGATIONS.has(c.req.header('sec-fetch-dest') ?? '')
      ? recordView({
          artifact,
          version,
          versionId: v.id,
          viewerId: viewer?.id ?? null,
          // Opened as a link-shared page (plain, with a key or a grant): recorded without anyone's identity
          identified: !(isCurrent && artifact.visibility === 'link'),
          visitor: `${clientIp(c) ?? ''}|${c.req.header('user-agent') ?? ''}`,
        })
      : null
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
    'Content-Security-Policy': contentCsp(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The sandboxed page has an opaque origin, so its fetch(), module scripts and web fonts are
    // cross-origin requests. "*" never applies to credentialed requests, and a restricted page's
    // files are only reachable under its link token, so this exposes nothing new.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': path === ENTRY_PATH ? ENTRY_CACHE : CACHE,
    ETag: `"${etag}"`,
  }
  await opened
  if (!token && !onContent) headers.Vary = 'Cookie'
  if (c.req.header('if-none-match') === `"${etag}"`) return c.body(null, 304, headers)
  return c.body(typeof body === 'string' ? body : new Uint8Array(body), 200, headers)
}

// Everything CONTENT_ORIGIN answers: a page's files, and not found for the rest, so the content host
// can never act as the app (sign-in, the API, MCP, OAuth, the web app). No session middleware.
export const contentHost = new Hono<AuthEnv>()
contentHost.get('/api/artifacts/:slug/v/:version', (c) => c.redirect(`${new URL(c.req.url).pathname}/`, 301))
contentHost.get('/api/artifacts/:slug/v/:version/*', serveVersion)
contentHost.notFound(notFound)
contentHost.onError(onUnhandledError)

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
  const link = token ? {} : await linkPassFor(c, artifact)
  if (!allowed(await accessLevel(artifact, viewer, link), version === artifact.currentVersion)) return notFound(c)
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
