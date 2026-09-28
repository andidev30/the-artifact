import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { and, eq, or, sql } from 'drizzle-orm'
import { chromium, type Browser, type BrowserContext, type Request, type Route } from 'playwright-core'
import { db, schema } from './db/index.js'
import { env } from './env.js'
import { sha256 } from './files.js'
import { holdStorageLock } from './gc.js'
import { log, requestContext } from './log.js'
import { thumbnailDuration, thumbnailQueue, thumbnailRendering } from './metrics.js'
import { getBlob, getText, putBlob } from './storage.js'

// Gallery thumbnails are screenshots of a version, taken in headless Chromium after it is published.
// Page HTML is untrusted and runs here on the server, so the browser gets no network of its own:
// - every request is intercepted; the page's own files are answered from memory (never over the API)
// - everything else is refused, except GETs to an allowlist of public CDN hosts, which this process
//   fetches itself after checking that every address the host resolves to is public, and then pins
// - as a backstop, Chromium is pointed at a proxy that doesn't exist (loopback included), so traffic
//   that interception doesn't see (WebSockets, workers) goes nowhere; WebRTC UDP is disabled
// - a fresh browser context per render, fixed viewport, no downloads, no service workers, short timeouts
// - renders that run at once (THUMBNAIL_CONCURRENCY) share one Chromium but never a context, and each
//   has its own interception, CDN budget and timeouts; nothing above is relaxed for them

export const VIEWPORT = { width: 1280, height: 720 }
// Stored at half size: 640x360, enough for a card on a 2x screen
const SCALE = 0.5
const QUALITY = 80
export const THUMBNAIL_TYPE = 'image/webp'

// The page is loaded from a made-up origin so relative URLs resolve and nothing real is reachable
export const PAGE_ORIGIN = 'https://page.the-artifact.invalid'
const SETTLE_MS = 700
const CDN_TIMEOUT = 5_000
const MAX_CDN_BYTES = 5 * 1024 * 1024
const MAX_CDN_TOTAL = 15 * 1024 * 1024
const MAX_CDN_REQUESTS = 60
const MAX_QUEUE = 1000
// Nothing listens here; see the note on the proxy above
const DEAD_PROXY = 'http://127.0.0.1:9'

export const DEFAULT_CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'ga.jspm.io',
  'cdn.skypack.dev',
  'cdn.tailwindcss.com',
  'code.jquery.com',
  'd3js.org',
  'cdn.plot.ly',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'rsms.me',
]

type Config = { chromePath: string; cdnHosts: Set<string>; concurrency: number; launchTimeout: number; loadTimeout: number; renderTimeout: number }

function hostsFrom(value: string | undefined): Set<string> {
  // Unset means the defaults; set (even to nothing) replaces them, so "" or "none" blocks every host
  if (value === undefined) return new Set(DEFAULT_CDN_HOSTS)
  return new Set(
    value
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h && h !== 'none'),
  )
}

let config: Config = {
  chromePath: env.thumbnails.chromePath,
  cdnHosts: hostsFrom(env.thumbnails.cdnHosts),
  concurrency: env.thumbnails.concurrency,
  launchTimeout: 15_000,
  loadTimeout: 8_000,
  renderTimeout: 20_000,
}

// For tests and scripts
export function configureThumbnails(next: Partial<Omit<Config, 'cdnHosts'>> & { cdnHosts?: string[] }) {
  config = { ...config, ...next, cdnHosts: next.cdnHosts ? new Set(next.cdnHosts) : config.cdnHosts }
}

export function thumbnailsEnabled(): boolean {
  return Boolean(config.chromePath)
}

// Addresses a CDN host must never resolve to: private, loopback, link-local (cloud metadata lives at
// 169.254.169.254), shared, documentation, multicast and reserved ranges, and IPv6 forms that embed IPv4
// (two lists: one BlockList would match every IPv4 address against the IPv4-mapped IPv6 range)
const NOT_PUBLIC_V4 = new BlockList()
const NOT_PUBLIC_V6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC_V4.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  // Unspecified, loopback and the deprecated IPv4-compatible addresses (::a.b.c.d)
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  NOT_PUBLIC_V6.addSubnet(net, bits, 'ipv6')

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (!family) return false
  return family === 4 ? !NOT_PUBLIC_V4.check(ip, 'ipv4') : !NOT_PUBLIC_V6.check(ip, 'ipv6')
}

export type PageTree = { html: string; files: { path: string; contentType: string; content: Buffer }[] }
export type RenderResult = { image: Buffer; blocked: string[] }

type Fetched = { status: number; headers: Record<string, string>; body: Buffer }

// A GET to an allowlisted CDN, made by this process with the vetted address pinned (so the name
// can't be re-resolved to something private in between) and the certificate checked for the name
export async function fetchFromCdn(url: URL, accept = '*/*'): Promise<Fetched | null> {
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return null
  if (!config.cdnHosts.has(url.hostname)) return null
  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true })
  } catch {
    return null
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) return null
  const pinned = addresses[0]

  return new Promise((resolve) => {
    const req = request(
      {
        host: pinned.address,
        family: pinned.family,
        port: 443,
        servername: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { host: url.hostname, accept, 'accept-encoding': 'identity', 'user-agent': 'TheArtifactThumbnails/1.0' },
        timeout: CDN_TIMEOUT,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_CDN_BYTES) {
            req.destroy()
            resolve(null)
          } else chunks.push(chunk)
        })
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const name of ['content-type', 'access-control-allow-origin', 'location']) {
            const value = res.headers[name]
            if (typeof value === 'string') headers[name] = value
          }
          resolve({ status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks) })
        })
        res.on('error', () => resolve(null))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

// One Chromium serves every render. A render that fails or hangs may have wedged it, so it is retired:
// the next render starts a fresh one at once, and the old one closes when the renders still on it are
// done (each has its own timeout), or after the longest a render may take. One bad page never makes
// the others wait. If Chromium dies, it is retired the same way and the renders on it fail with
// BrowserGone, which renderThumbnail retries once on the new browser.
type Instance = { browser: Promise<Browser>; renders: number; retired: boolean; gone: boolean; closed: boolean }
let current: Instance | null = null
let explainedSandbox = false
let rendering = 0

export class BrowserGone extends Error {}

// Chromium doesn't inherit this server's environment (database URL, SMTP password...)
function browserEnv(): Record<string, string> {
  const keep: Record<string, string> = { TZ: 'UTC', LANG: 'en_US.UTF-8', HOME: tmpdir() }
  for (const name of ['PATH', 'TMPDIR', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'XDG_CACHE_HOME']) {
    const value = process.env[name]
    if (value) keep[name] = value
  }
  return keep
}

function launch(): Instance {
  const instance: Instance = {
    browser: chromium.launch({
      executablePath: config.chromePath,
      headless: true,
      chromiumSandbox: true,
      env: browserEnv(),
      timeout: config.launchTimeout,
      args: [
        `--proxy-server=${DEAD_PROXY}`,
        // Without this, Chromium sends localhost straight past the proxy
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--dns-prefetch-disable',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-sync',
        '--disable-extensions',
        '--no-first-run',
        '--no-pings',
        '--mute-audio',
        '--hide-scrollbars',
      ],
    }),
    renders: 0,
    retired: false,
    gone: false,
    closed: false,
  }
  instance.browser.then(
    (b) =>
      b.on('disconnected', () => {
        instance.gone = true
        retire(instance)
      }),
    (err) => {
      instance.closed = true
      if (current === instance) current = null
      if (!explainedSandbox && /sandbox|namespace/i.test(String(err))) {
        explainedSandbox = true
        log.error(
          'Thumbnails are off: Chromium could not start its sandbox. Run the app with the seccomp profile in ' +
            'deploy/seccomp-chromium.json (deploy/docker-compose does; on Kubernetes see docs/kubernetes.md). See docs/security.md.',
        )
      }
    },
  )
  return instance
}

async function close(instance: Instance) {
  if (instance.closed) return
  instance.closed = true
  await instance.browser.then((b) => b.close()).catch(() => {})
}

function retire(instance: Instance) {
  if (current === instance) current = null
  if (instance.retired) return
  instance.retired = true
  if (instance.renders === 0) void close(instance)
  // By then every render on it has timed out; this only catches a browser too wedged to answer
  else setTimeout(() => void close(instance), config.renderTimeout + 10_000).unref()
}

function release(instance: Instance) {
  instance.renders -= 1
  if (instance.retired && instance.renders === 0) void close(instance)
}

export async function closeThumbnailBrowser() {
  const instance = current
  current = null
  if (instance) {
    instance.retired = true
    await close(instance)
  }
}

// Renders in progress right now
export function thumbnailsRendering(): number {
  return rendering
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// Renders the page and returns a WebP screenshot, plus every URL it tried to reach and was refused
export async function renderPage(tree: PageTree): Promise<RenderResult> {
  if (!config.chromePath) throw new Error('No browser configured (CHROME_PATH)')
  current ??= launch()
  const instance = current
  instance.renders += 1
  rendering += 1
  thumbnailRendering.set(rendering)
  const contexts: Promise<BrowserContext>[] = []
  let ok = false
  try {
    const b = await instance.browser
    const blocked: string[] = []
    let cdnBytes = 0
    let cdnRequests = 0
    const files = new Map(tree.files.map((f) => [f.path, f]))

    async function handle(route: Route, req: Request) {
      const url = new URL(req.url())
      if (url.origin === PAGE_ORIGIN) {
        let path: string
        try {
          path = decodeURIComponent(url.pathname.slice(1))
        } catch {
          return route.fulfill({ status: 404, body: '' })
        }
        if (path === '' || path === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tree.html })
        const file = files.get(path)
        if (!file) return route.fulfill({ status: 404, body: '' })
        return route.fulfill({ status: 200, contentType: file.contentType, body: file.content })
      }
      if (req.method() === 'GET' && cdnRequests < MAX_CDN_REQUESTS && cdnBytes < MAX_CDN_TOTAL) {
        cdnRequests += 1
        const res = await fetchFromCdn(url, req.headers().accept).catch(() => null)
        if (res && cdnBytes + res.body.length <= MAX_CDN_TOTAL) {
          cdnBytes += res.body.length
          // Redirects go back through this handler, so their targets are checked too
          return route.fulfill({ status: res.status, headers: res.headers, body: res.body })
        }
      }
      blocked.push(url.href)
      return route.abort('blockedbyclient')
    }

    // Everything from the new context to the screenshot is under one timeout, so a browser that
    // stops answering can't hold this render (and its place in the queue) longer than that
    const shot = (async () => {
      const context = b.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
        reducedMotion: 'reduce',
        colorScheme: 'light',
      })
      contexts.push(context)
      const ctx = await context
      await ctx.route('**/*', (route, req) => handle(route, req).catch(() => route.abort().catch(() => {})))
      await ctx.routeWebSocket(/.*/, (ws) => {
        blocked.push(ws.url())
        ws.close()
      })
      const page = await ctx.newPage()
      await page.goto(`${PAGE_ORIGIN}/`, { waitUntil: 'load', timeout: config.loadTimeout }).catch(() => {})
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      const cdp = await ctx.newCDPSession(page)
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'webp',
        quality: QUALITY,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: SCALE },
      })
      return Buffer.from(data, 'base64')
    })()
    // It may still reject after the timeout below has given up on it
    shot.catch(() => {})
    const image = await withTimeout(shot, config.renderTimeout, 'Rendering the thumbnail')
    ok = true
    return { image, blocked }
  } catch (err) {
    const b = await instance.browser.catch(() => null)
    // Closing or closed under this render: not the page's doing (errors can arrive before Chromium says it is gone)
    if (b && (instance.closed || instance.gone || !b.isConnected())) throw new BrowserGone('The browser closed while rendering')
    throw err
  } finally {
    for (const context of contexts)
      await withTimeout(
        context.then((c) => c.close()),
        5_000,
        'Closing the context',
      ).catch(() => {})
    if (!ok) retire(instance)
    release(instance)
    rendering -= 1
    thumbnailRendering.set(rendering)
  }
}

async function loadTree(versionId: string): Promise<PageTree | null> {
  const [v] = await db.select({ htmlSha256: schema.artifactVersions.htmlSha256 }).from(schema.artifactVersions).where(eq(schema.artifactVersions.id, versionId))
  if (!v) return null
  const html = await getText(v.htmlSha256)
  if (html === null) return null
  const rows = await db
    .select({ path: schema.artifactFiles.path, contentType: schema.artifactFiles.contentType, sha256: schema.artifactFiles.sha256 })
    .from(schema.artifactFiles)
    .where(eq(schema.artifactFiles.versionId, versionId))
  const files = await Promise.all(rows.map(async (f) => ({ path: f.path, contentType: f.contentType, content: (await getBlob(f.sha256)) ?? Buffer.alloc(0) })))
  return { html, files }
}

async function store(versionId: string, values: { image: Buffer | null; contentType: string | null; error: string | null }) {
  const row = { sha256: values.image ? sha256(values.image) : null, contentType: values.contentType, error: values.error }
  await db.transaction(async (tx) => {
    await holdStorageLock(tx)
    if (values.image) await putBlob(values.image, row.sha256!)
    await tx
      .insert(schema.artifactThumbnails)
      .values({ versionId, ...row })
      .onConflictDoUpdate({ target: schema.artifactThumbnails.versionId, set: { ...row, createdAt: sql`now()` } })
  })
}

// Renders one version and stores the result; a failure is stored too, so it isn't retried endlessly
export async function renderThumbnail(versionId: string): Promise<'stored' | 'failed' | 'missing'> {
  const tree = await loadTree(versionId)
  if (!tree) return 'missing'
  const end = thumbnailDuration.startTimer()
  try {
    // Chromium dying takes every render on it down; each gets one more try on a fresh one
    const { image } = await renderPage(tree).catch((err) => {
      if (err instanceof BrowserGone) return renderPage(tree)
      throw err
    })
    await store(versionId, { image, contentType: THUMBNAIL_TYPE, error: null })
    end({ outcome: 'stored' })
    return 'stored'
  } catch (err) {
    end({ outcome: 'failed' })
    const message = err instanceof Error ? err.message : String(err)
    log.error('Thumbnail failed', { versionId, error: message })
    // The version may have been deleted while it rendered
    await store(versionId, { image: null, contentType: null, error: message.slice(0, 500) }).catch(() => {})
    return 'failed'
  }
}

// Up to `concurrency` renders at a time, in the background, so publishing never waits for a browser
const pending: string[] = []
const queued = new Set<string>()
const workers = new Set<Promise<void>>()

// True when the version is (now) waiting for a render or being rendered
export function queueThumbnail(versionId: string): boolean {
  if (!thumbnailsEnabled()) return false
  if (queued.has(versionId)) return true
  if (queued.size >= MAX_QUEUE) return false
  queued.add(versionId)
  thumbnailQueue.set(queued.size)
  pending.push(versionId)
  if (workers.size < config.concurrency) {
    // Outside the request's context: the queue outlives it and renders other people's versions too,
    // so its log lines shouldn't carry this request's id
    const worker: Promise<void> = requestContext.exit(work).finally(() => workers.delete(worker))
    workers.add(worker)
  }
  return true
}

async function work() {
  // Let the publish that queued this finish its response first
  await new Promise((r) => setImmediate(r))
  while (pending.length) {
    const id = pending.shift()!
    try {
      await renderThumbnail(id)
    } catch (err) {
      log.error('Thumbnail queue failed', { versionId: id, err })
    } finally {
      queued.delete(id)
      thumbnailQueue.set(queued.size)
    }
  }
}

// Where a page's screenshot of its current version stands:
// - ready: it exists
// - pending: it is queued or being rendered, so asking again soon may find it
// - none: it won't come (no browser set up, the render failed, or the queue is full)
export type ThumbnailState = 'ready' | 'pending' | 'none'

// The thumbnail state of each of these pages, by page id. Versions that were never rendered
// (published before thumbnails existed, or while no browser was set up) are queued now.
export async function currentThumbnails(pages: { id: string; currentVersion: number }[]): Promise<Map<string, ThumbnailState>> {
  if (pages.length === 0) return new Map()
  const v = schema.artifactVersions
  const t = schema.artifactThumbnails
  const rows = await db
    .select({ artifactId: v.artifactId, versionId: v.id, tried: sql<boolean>`${t.versionId} is not null`, ready: sql<boolean>`${t.sha256} is not null` })
    .from(v)
    .leftJoin(t, eq(t.versionId, v.id))
    .where(or(...pages.map((p) => and(eq(v.artifactId, p.id), eq(v.version, p.currentVersion)))))
  const states = new Map<string, ThumbnailState>()
  for (const r of rows) states.set(r.artifactId, r.ready ? 'ready' : !r.tried && queueThumbnail(r.versionId) ? 'pending' : 'none')
  return states
}

// A version's stored render: its image, or null image when rendering failed; null when never tried
export async function getThumbnail(versionId: string) {
  const [row] = await db.select().from(schema.artifactThumbnails).where(eq(schema.artifactThumbnails.versionId, versionId))
  if (!row) return null
  return { ...row, image: row.sha256 ? await getBlob(row.sha256) : null }
}

// Resolves once the queue is empty (tests and the backfill script wait on it)
export async function thumbnailQueueIdle() {
  while (workers.size) await Promise.all(workers)
}
