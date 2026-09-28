import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { getBlob } from '../../src/storage.js'
import {
  closeThumbnailBrowser,
  configureThumbnails,
  fetchFromCdn,
  isPublicAddress,
  queueThumbnail,
  renderPage,
  thumbnailQueueIdle,
  thumbnailsRendering,
} from '../../src/thumbnails.js'
import { call, createPage, createUser, type TestUser } from './helpers.js'

// Uses the installed Chrome (or TEST_CHROME_PATH); the rendering tests are skipped without one
const CHROME = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = existsSync(CHROME)

function isWebp(buf: Buffer) {
  return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
}

// WebP stores the canvas size in the VP8/VP8L/VP8X header
function webpSize(buf: Buffer): { width: number; height: number } {
  const chunk = buf.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
}

afterEach(async () => {
  await thumbnailQueueIdle()
  configureThumbnails({ chromePath: '' })
})

afterAll(async () => {
  await closeThumbnailBrowser()
})

describe('without a browser', () => {
  it('publishing skips thumbnails and cards keep the sketch', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    await thumbnailQueueIdle()
    expect(await db.select().from(schema.artifactThumbnails)).toEqual([])
    const [card] = await (await call('/api/artifacts', { cookie: owner.cookie })).json()
    // Nothing is coming, so the gallery has no reason to ask again
    expect(card).toMatchObject({ thumbnail: false, thumbnailState: 'none' })
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/1`, { cookie: owner.cookie })).status).toBe(404)
    expect(await db.select().from(schema.artifactThumbnails)).toEqual([])
  })

  it('a browser that fails to start records the failure once and publishing still works', async () => {
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const page = await createPage(owner)
    await thumbnailQueueIdle()
    const [row] = await db.select().from(schema.artifactThumbnails)
    expect(row.sha256).toBeNull()
    expect(row.error).toBeTruthy()
    // Not queued again on every gallery load, and the gallery stops waiting for it
    const [card] = await (await call('/api/artifacts', { cookie: owner.cookie })).json()
    expect(card).toMatchObject({ slug: page.slug, thumbnail: false, thumbnailState: 'none' })
    await thumbnailQueueIdle()
    expect((await db.select().from(schema.artifactThumbnails)).length).toBe(1)
  })
})

describe('address checks for CDN requests', () => {
  it('only public addresses count', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      'not an ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
    for (const ip of ['104.16.85.20', '151.101.1.229', '8.8.8.8', '2606:4700::6810:5514']) expect(isPublicAddress(ip), ip).toBe(true)
  })

  it('refuses hosts off the list, other schemes and ports, and names that resolve to private addresses', async () => {
    configureThumbnails({ cdnHosts: ['localhost', 'cdn.jsdelivr.net'] })
    expect(await fetchFromCdn(new URL('https://localhost/x.js'))).toBeNull()
    expect(await fetchFromCdn(new URL('https://example.com/x.js'))).toBeNull()
    expect(await fetchFromCdn(new URL('http://cdn.jsdelivr.net/x.js'))).toBeNull()
    expect(await fetchFromCdn(new URL('https://cdn.jsdelivr.net:8443/x.js'))).toBeNull()
    expect(await fetchFromCdn(new URL('https://user:pw@cdn.jsdelivr.net/x.js'))).toBeNull()
  })
})

describe.skipIf(!hasChrome)('rendering in headless Chrome', { timeout: 30_000 }, () => {
  let listener: Server
  let port: number
  const hits: string[] = []
  let connections = 0

  beforeAll(async () => {
    listener = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.end('reached')
    })
    listener.on('connection', () => (connections += 1))
    listener.on('upgrade', (req, socket) => {
      hits.push(`upgrade ${req.url}`)
      socket.destroy()
    })
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
    port = (listener.address() as AddressInfo).port

    // The first Chrome start on a cold CI runner can pass the server's 15 s launch timeout, so it
    // happens here with more time, outside every test's own limit. A Chrome that can't start fails
    // at once rather than by timing out, and fails this hook loudly.
    configureThumbnails({ chromePath: CHROME, launchTimeout: 60_000 })
    const warm = await renderPage({ html: '<h1>warm</h1>', files: [] })
    expect(isWebp(warm.image)).toBe(true)
  }, 90_000)

  afterAll(async () => {
    await new Promise((r) => listener.close(r))
    configureThumbnails({ launchTimeout: 15_000, concurrency: 2 })
  })

  afterEach(() => {
    configureThumbnails({ concurrency: 2, loadTimeout: 8000, renderTimeout: 20_000 })
  })

  // How many renders ran at once until the queue was empty
  async function mostAtOnce() {
    let most = 0
    const poll = setInterval(() => (most = Math.max(most, thumbnailsRendering())), 5)
    try {
      await thumbnailQueueIdle()
    } finally {
      clearInterval(poll)
    }
    return most
  }

  function enable() {
    configureThumbnails({ chromePath: CHROME, cdnHosts: [] })
  }

  async function publishSite(owner: TestUser, html: string, files: { path: string; content: string }[] = [], visibility: 'private' | 'link' = 'private') {
    return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html, files, visibility })
  }

  it('renders after publishing, in the background, and serves it with access checks', async () => {
    enable()
    const owner = await createUser()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const stranger = await createUser()
    const page = await publishSite(owner, '<link rel="stylesheet" href="s.css"><h1>Hello</h1>', [{ path: 's.css', content: 'body{background:#0a7}' }])
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })
    await thumbnailQueueIdle()

    const [row] = await db.select().from(schema.artifactThumbnails)
    expect(row.error).toBeNull()
    expect(row.contentType).toBe('image/webp')
    const image = (await getBlob(row.sha256!))!
    expect(isWebp(image)).toBe(true)
    expect(webpSize(image)).toEqual({ width: 640, height: 360 })

    const [card] = await (await call('/api/artifacts', { cookie: owner.cookie })).json()
    expect(card).toMatchObject({ thumbnail: true, thumbnailState: 'ready' })

    const url = `/api/artifacts/${page.slug}/thumbnails/1`
    const res = await call(url, { cookie: viewer.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(isWebp(Buffer.from(await res.arrayBuffer()))).toBe(true)
    expect((await call(url, { cookie: viewer.cookie, headers: { 'if-none-match': res.headers.get('etag')! } })).status).toBe(304)
    expect((await call(url, { cookie: stranger.cookie })).status).toBe(404)
    expect((await call(url)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/2`, { cookie: owner.cookie })).status).toBe(404)

    // Old versions' thumbnails are for editors; restoring reuses the screenshot
    await publishSite(owner, '<h1>v2</h1>').then(() =>
      publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html: '<h1>v2</h1>', slug: page.slug }),
    )
    await thumbnailQueueIdle()
    expect((await call(url, { cookie: viewer.cookie })).status).toBe(404)
    expect((await call(url, { cookie: owner.cookie })).status).toBe(200)
    const before = (await db.select().from(schema.artifactThumbnails)).length
    expect((await call(`/api/artifacts/${page.slug}/versions/1/restore`, { method: 'POST', cookie: owner.cookie })).status).toBe(200)
    await thumbnailQueueIdle()
    expect((await db.select().from(schema.artifactThumbnails)).length).toBe(before + 1)
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/3`, { cookie: viewer.cookie })).status).toBe(200)
  })

  it('backfills pages published before thumbnails existed when the gallery asks', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    await thumbnailQueueIdle()
    expect(await db.select().from(schema.artifactThumbnails)).toEqual([])

    enable()
    const [card] = await (await call('/api/artifacts', { cookie: owner.cookie })).json()
    expect(card).toMatchObject({ slug: page.slug, thumbnail: false, thumbnailState: 'pending' })
    await thumbnailQueueIdle()
    const [again] = await (await call('/api/artifacts', { cookie: owner.cookie })).json()
    expect(again).toMatchObject({ thumbnail: true, thumbnailState: 'ready' })
  })

  it('runs the page script with its own files but reaches nothing on the network', async () => {
    enable()
    const local = `http://127.0.0.1:${port}`
    const html = `<!doctype html>
      <link rel="stylesheet" href="${local}/css">
      <img src="${local}/img"><img src="http://localhost:${port}/localhost-img"><img src="http://169.254.169.254/latest/meta-data/">
      <iframe src="${local}/frame"></iframe>
      <script src="${local}/script"></script>
      <script src="app.js"></script>`
    const app = `
      fetch('data.json').then((r) => r.json()).then((d) => fetch('${local}/own-file-said-' + d.word).catch(() => {}))
      fetch('${local}/fetch').catch(() => {})
      fetch('http://169.254.169.254/latest/meta-data/iam/security-credentials/').catch(() => {})
      fetch('http://[::1]:${port}/v6').catch(() => {})
      try { new WebSocket('ws://127.0.0.1:${port}/ws') } catch {}
      try { new EventSource('${local}/sse') } catch {}
      try { navigator.sendBeacon('${local}/beacon', 'x') } catch {}
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('${local}/worker').catch(() => {}); try { new WebSocket('ws://127.0.0.1:${port}/worker-ws') } catch {}"])))
      try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] }).createDataChannel('x') } catch {}
      setTimeout(() => { location.href = '${local}/navigate' }, 200)`
    const result = await renderPage({
      html,
      files: [
        { path: 'app.js', contentType: 'text/javascript', content: Buffer.from(app) },
        { path: 'data.json', contentType: 'application/json', content: Buffer.from('{"word":"hello"}') },
      ],
    })

    expect(isWebp(result.image)).toBe(true)
    expect(hits).toEqual([])
    expect(connections).toBe(0)
    // The page's own data file was served from memory and its script ran
    expect(result.blocked).toContain(`${local}/own-file-said-hello`)
    for (const url of [
      `${local}/css`,
      `${local}/img`,
      `${local}/script`,
      `${local}/fetch`,
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    ]) {
      expect(result.blocked).toContain(url)
    }
  })

  it('gives up on a page that never stops, and the next one still renders', async () => {
    enable()
    configureThumbnails({ loadTimeout: 1500, renderTimeout: 4000 })
    try {
      const started = Date.now()
      await expect(renderPage({ html: '<script>while (true) {}</script>', files: [] })).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(15_000)
      const ok = await renderPage({ html: '<h1>fine</h1>', files: [] })
      expect(isWebp(ok.image)).toBe(true)
    } finally {
      configureThumbnails({ loadTimeout: 8000, renderTimeout: 20_000 })
    }
  }, 40_000)

  it('each render starts from a clean browser context', async () => {
    enable()
    await renderPage({ html: '<script>localStorage.setItem("x", "1"); document.cookie = "a=1"</script>', files: [] })
    const second = await renderPage({
      html: `<script>if (localStorage.getItem('x') || document.cookie) fetch('http://127.0.0.1:${port}/leaked')</script>`,
      files: [],
    })
    expect(second.blocked).toEqual([])
  })

  it('tells the gallery a render is on its way, then whether it came or failed', async () => {
    enable()
    configureThumbnails({ loadTimeout: 1500, renderTimeout: 4000 })
    try {
      const owner = await createUser()
      const good = await createPage(owner, { title: 'Good', html: '<h1>fine</h1>' })
      const bad = await createPage(owner, { title: 'Bad', html: '<script>while (true) {}</script>' })
      const states = async () => {
        const cards = (await (await call('/api/artifacts', { cookie: owner.cookie })).json()) as { slug: string; thumbnailState: string }[]
        return Object.fromEntries(cards.map((c) => [c.slug, c.thumbnailState]))
      }
      // Asked right after publishing, before the background renders are done
      expect(await states()).toEqual({ [good.slug]: 'pending', [bad.slug]: 'pending' })
      await thumbnailQueueIdle()
      expect(await states()).toEqual({ [good.slug]: 'ready', [bad.slug]: 'none' })
    } finally {
      configureThumbnails({ loadTimeout: 8000, renderTimeout: 20_000 })
    }
  }, 40_000)

  it('queues each version once', async () => {
    enable()
    const owner = await createUser()
    const page = await createPage(owner)
    const [v] = await db.select().from(schema.artifactVersions)
    queueThumbnail(v.id)
    queueThumbnail(v.id)
    await thumbnailQueueIdle()
    expect((await db.select().from(schema.artifactThumbnails)).length).toBe(1)
    expect(page.slug).toBeTruthy()
  })

  it('renders up to THUMBNAIL_CONCURRENCY pages at once, never more', async () => {
    enable()
    const owner = await createUser()
    for (const concurrency of [1, 3]) {
      configureThumbnails({ concurrency })
      for (let i = 0; i < 6; i++) await createPage(owner, { title: `Page ${concurrency}-${i}`, html: `<h1>${i}</h1>` })
      expect(await mostAtOnce()).toBe(concurrency)
    }
    const rows = await db.select().from(schema.artifactThumbnails)
    expect(rows.length).toBe(12)
    expect(rows.every((r) => r.sha256 && !r.error)).toBe(true)
    expect(thumbnailsRendering()).toBe(0)
  }, 60_000)

  it('keeps pages rendering at the same time apart, with no network', async () => {
    enable()
    const local = `http://127.0.0.1:${port}`
    const site = (name: string) => ({
      html: `<!doctype html><img src="${local}/${name}-img"><script src="app.js"></script>`,
      files: [
        {
          path: 'app.js',
          contentType: 'text/javascript',
          content: Buffer.from(`
            if (localStorage.getItem('owner') || document.cookie) fetch('${local}/${name}-saw-another-page').catch(() => {})
            localStorage.setItem('owner', '${name}'); document.cookie = 'owner=${name}'
            fetch('secret.txt').then((r) => r.text()).then((t) => fetch('${local}/${name}-read-' + t).catch(() => {}))
            try { new WebSocket('ws://127.0.0.1:${port}/${name}-ws') } catch {}
            fetch('http://169.254.169.254/${name}').catch(() => {})`),
        },
        { path: 'secret.txt', contentType: 'text/plain', content: Buffer.from(`${name}-only`) },
      ],
    })
    const names = ['alpha', 'beta', 'gamma', 'delta']
    const results = await Promise.all(names.map((name) => renderPage(site(name))))

    expect(hits).toEqual([])
    expect(connections).toBe(0)
    for (const [i, name] of names.entries()) {
      const { blocked, image } = results[i]
      expect(isWebp(image)).toBe(true)
      // Each page got its own files, and never saw another's storage or requests
      expect(blocked).toContain(`${local}/${name}-read-${name}-only`)
      expect(blocked).toContain(`${local}/${name}-img`)
      expect(blocked).toContain(`http://169.254.169.254/${name}`)
      expect(blocked.filter((url) => url.includes('saw-another-page'))).toEqual([])
      for (const other of names.filter((n) => n !== name)) expect(blocked.some((url) => url.includes(other))).toBe(false)
    }
  })

  it('a page that hangs holds up only its own render', async () => {
    enable()
    configureThumbnails({ concurrency: 2, loadTimeout: 1500, renderTimeout: 4000 })
    const owner = await createUser()
    const bad = await createPage(owner, { title: 'Bad', html: '<script>while (true) {}</script>' })
    const good = [await createPage(owner, { title: 'Good 1', html: '<h1>one</h1>' }), await createPage(owner, { title: 'Good 2', html: '<h1>two</h1>' })]
    await thumbnailQueueIdle()

    const rows = await db
      .select({ slug: schema.artifacts.slug, sha256: schema.artifactThumbnails.sha256, createdAt: schema.artifactThumbnails.createdAt })
      .from(schema.artifactThumbnails)
      .innerJoin(schema.artifactVersions, eq(schema.artifactVersions.id, schema.artifactThumbnails.versionId))
      .innerJoin(schema.artifacts, eq(schema.artifacts.id, schema.artifactVersions.artifactId))
    const bySlug = new Map(rows.map((r) => [r.slug, r]))
    expect(bySlug.get(bad.slug)?.sha256).toBeNull()
    for (const page of good) {
      const row = bySlug.get(page.slug)!
      expect(row.sha256).toBeTruthy()
      // Rendered in the other slot while the bad page was still running, not after it gave up
      expect(row.createdAt.getTime()).toBeLessThan(bySlug.get(bad.slug)!.createdAt.getTime())
    }
  }, 40_000)

  it('starts a new browser when Chromium goes away mid-batch, and renders what was on it again', async () => {
    enable()
    configureThumbnails({ concurrency: 2 })
    const owner = await createUser()
    for (let i = 0; i < 4; i++) await createPage(owner, { title: `Page ${i}`, html: `<h1>${i}</h1>` })
    while (thumbnailsRendering() < 2) await new Promise((r) => setTimeout(r, 5))
    await closeThumbnailBrowser()
    await thumbnailQueueIdle()

    const rows = await db.select().from(schema.artifactThumbnails)
    expect(rows.length).toBe(4)
    expect(rows.map((r) => r.error)).toEqual([null, null, null, null])
    expect(isWebp((await renderPage({ html: '<h1>after</h1>', files: [] })).image)).toBe(true)
  }, 60_000)
})
