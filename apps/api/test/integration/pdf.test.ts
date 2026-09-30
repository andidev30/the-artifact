import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { storedPdf, storePdf, sweepPdfs } from '../../src/pdf.js'
import { getObject, putObject } from '../../src/storage.js'
import { closeThumbnailBrowser, configureThumbnails, renderPage } from '../../src/thumbnails.js'
import { call, createPage, createUser, type TestUser } from './helpers.js'

const CHROME = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = existsSync(CHROME)

const originalLimits = env.rateLimits

afterEach(() => {
  env.rateLimits = originalLimits
  configureThumbnails({ chromePath: '' })
})

afterAll(async () => {
  await closeThumbnailBrowser()
})

const pdfOf = (slug: string, cookie?: string, query = '') => call(`/api/artifacts/${slug}/pdf${query}`, { cookie })

async function versionIdOf(artifactId: string, version = 1) {
  const rows = await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, artifactId))
  return rows.find((r) => r.version === version)!.id
}

// The size of each page, in points, from the PDF's MediaBox entries
function pageSizes(pdf: Buffer): number[][] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*([\d.\s]+)\]/g)].map((m) => m[1].trim().split(/\s+/).slice(2).map(Number).map(Math.round))
}

describe('who can download a PDF', () => {
  it('shows the app whether this server makes PDFs', async () => {
    expect(((await (await call('/api/config')).json()) as { pdf: boolean }).pdf).toBe(false)
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    expect(((await (await call('/api/config')).json()) as { pdf: boolean }).pdf).toBe(true)
  })

  it('says a server without a browser cannot make PDFs, to people who can open the page only', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const page = await createPage(owner)
    const res = await pdfOf(page.slug, owner.cookie)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "This server can't make PDFs." })
    expect(await (await pdfOf(page.slug, stranger.cookie)).json()).toEqual({ error: 'Not found' })
  })

  it('answers like a missing page for strangers, older versions for viewers and pages that do not exist', async () => {
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const stranger = await createUser()
    const page = await createPage(owner, { title: 'Report' })
    await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Report', html: '<h1>Two</h1>', slug: page.slug })
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })

    for (const res of [
      await pdfOf(page.slug, stranger.cookie),
      await pdfOf(page.slug),
      await pdfOf(page.slug, viewer.cookie, '?version=1'),
      await pdfOf(page.slug, owner.cookie, '?version=9'),
      await pdfOf(page.slug, owner.cookie, '?version=abc'),
      await pdfOf('doesnotexist', owner.cookie),
    ]) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    }
    // Refused before any of them counted toward the limit
    expect((await db.select().from(schema.rateLimits)).filter((r) => r.bucket === 'pdf')).toEqual([])
  })

  it('is rate-limited per account, and per network for people who are not signed in', async () => {
    env.rateLimits = 'pdf=2/1h'
    // A browser that can't start: each PDF fails at once, but still counts
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    for (let i = 0; i < 2; i++) {
      const res = await pdfOf(page.slug, owner.cookie)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: string }).error).toMatch(/^The PDF could not be made: /)
    }
    const refused = await pdfOf(page.slug, owner.cookie)
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: string }).error).toMatch(/^You have made a lot of PDFs in a short time\. Try again in/)
    // Someone else has their own count
    expect((await pdfOf(page.slug)).status).toBe(422)
  })
})

describe('PDFs kept in the bucket', () => {
  it('serves a version printed before without printing it again or counting it', async () => {
    env.rateLimits = 'pdf=1/1h'
    // A browser that can't start: anything that needed printing would fail
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Kept' })
    await storePdf(await versionIdOf(page.id), Buffer.from('%PDF-kept'))
    for (let i = 0; i < 3; i++) {
      const res = await pdfOf(page.slug, owner.cookie)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="kept-v1.pdf"')
      expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toBe('%PDF-kept')
    }
    expect((await db.select().from(schema.rateLimits)).filter((r) => r.bucket === 'pdf')).toEqual([])
    // Still for people who can open it only
    expect((await pdfOf(page.slug)).status).toBe(404)
  })

  it('sweeps the PDFs of deleted versions and older formats, and keeps the rest', async () => {
    const owner = await createUser()
    const kept = await createPage(owner)
    const deleted = await createPage(owner)
    const keptId = await versionIdOf(kept.id)
    const deletedId = await versionIdOf(deleted.id)
    await storePdf(keptId, Buffer.from('%PDF-kept'))
    await storePdf(deletedId, Buffer.from('%PDF-gone'))
    await putObject(`pdfs/0/${keptId}.pdf`, Buffer.from('%PDF-old'))
    await putObject('pdfs/1/not-a-version.pdf', Buffer.from('%PDF-odd'))
    await db.delete(schema.artifacts).where(eq(schema.artifacts.id, deleted.id))

    expect(await sweepPdfs()).toBeGreaterThanOrEqual(3)
    expect((await storedPdf(keptId))?.toString()).toBe('%PDF-kept')
    expect(await storedPdf(deletedId)).toBeNull()
    expect(await getObject(`pdfs/0/${keptId}.pdf`)).toBeNull()
    expect(await getObject('pdfs/1/not-a-version.pdf')).toBeNull()
    // Nothing is left to sweep; a sweep past its deadline doesn't look
    expect(await sweepPdfs(Date.now() - 1)).toBe(0)
  })
})

describe.skipIf(!hasChrome)('printing in headless Chrome', { timeout: 60_000 }, () => {
  let listener: Server
  let port: number
  const hits: string[] = []

  beforeAll(async () => {
    listener = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.end('reached')
    })
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
    port = (listener.address() as AddressInfo).port
    // A cold Chrome start can take longer than the server's launch timeout (see thumbnails.test.ts)
    configureThumbnails({ chromePath: CHROME, launchTimeout: 60_000 })
    await renderPage({ html: '<h1>warm</h1>', files: [] })
  }, 90_000)

  afterAll(async () => {
    await new Promise((r) => listener.close(r))
    configureThumbnails({ launchTimeout: 15_000 })
  })

  function enable() {
    configureThumbnails({ chromePath: CHROME, cdnHosts: [] })
  }

  async function publishSite(owner: TestUser, html: string, opts: { title?: string; slug?: string } = {}) {
    return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: opts.title ?? 'Site', html, slug: opts.slug })
  }

  it('prints the page on A4 by default, named after the page and version', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(owner, '<!doctype html><title>Q3</title><h1>Signups by week</h1><div style="height: 2000px"></div><p>End</p>', {
      title: 'Signups by week',
    })
    const res = await pdfOf(page.slug, owner.cookie)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="signups-by-week-v1.pdf"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const pdf = Buffer.from(await res.arrayBuffer())
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // Kept for next time
    expect((await storedPdf(await versionIdOf(page.id)))?.equals(pdf)).toBe(true)
    // A4 is 210 × 297 mm, which Chrome makes 595.92 × 842.88 points; a page over 2000 px tall runs to more than one sheet
    const sizes = pageSizes(pdf)
    expect(sizes.length).toBeGreaterThan(1)
    for (const size of sizes) expect(size).toEqual([596, 843])
  })

  it('uses the paper size the page asks for and its print styles', async () => {
    enable()
    const owner = await createUser()
    // A deck of three 1280 × 720 slides that shows one at a time on screen and all of them in print
    const page = await publishSite(
      owner,
      `<!doctype html><title>Deck</title><style>
        @page { size: 1280px 720px; margin: 0 }
        body { margin: 0 }
        .slide { width: 1280px; height: 720px; display: none }
        .slide:first-child { display: block }
        @media print { .slide { display: block } .slide:not(:last-child) { break-after: page } }
      </style><div class="slide">One</div><div class="slide">Two</div><div class="slide">Three</div>`,
    )
    const pdf = Buffer.from(await (await pdfOf(page.slug, owner.cookie)).arrayBuffer())
    // 1280 × 720 CSS pixels are 960 × 540 points
    expect(pageSizes(pdf)).toEqual([
      [960, 540],
      [960, 540],
      [960, 540],
    ])
  })

  it('prints an older version for editors and the current one for anyone with the link', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(owner, '<h1>One</h1>', { title: 'Notes' })
    await publishSite(owner, '<h1>Two</h1>', { title: 'Notes', slug: page.slug })
    await db.update(schema.artifacts).set({ visibility: 'link' }).where(eq(schema.artifacts.slug, page.slug))
    const old = await pdfOf(page.slug, owner.cookie, '?version=1')
    expect(old.status).toBe(200)
    expect(old.headers.get('content-disposition')).toBe('attachment; filename="notes-v1.pdf"')
    const current = await pdfOf(page.slug)
    expect(current.status).toBe(200)
    expect(current.headers.get('content-disposition')).toBe('attachment; filename="notes-v2.pdf"')
    expect((await pdfOf(page.slug, undefined, '?version=1')).status).toBe(404)
  })

  it('reaches nothing beyond the page while printing', async () => {
    enable()
    const local = `http://127.0.0.1:${port}`
    const owner = await createUser()
    const page = await publishSite(
      owner,
      `<!doctype html><title>Nosy</title><h1>Nosy</h1><img alt="" src="${local}/img">
      <script>fetch('${local}/fetch').catch(() => {}); fetch('${env.appUrl}/api/me', { credentials: 'include' }).catch(() => {})</script>`,
    )
    expect((await pdfOf(page.slug, owner.cookie)).status).toBe(200)
    expect(hits).toEqual([])
  })

  it('reports a page that never finishes, and the next one prints', async () => {
    enable()
    configureThumbnails({ loadTimeout: 1500, renderTimeout: 4000 })
    try {
      const owner = await createUser()
      const bad = await createPage(owner, { html: '<script>while (true) {}</script>' })
      const res = await pdfOf(bad.slug, owner.cookie)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: string }).error).toMatch(/^The PDF could not be made: Making the PDF took longer than 4000 ms/)
      const good = await createPage(owner)
      expect((await pdfOf(good.slug, owner.cookie)).status).toBe(200)
    } finally {
      configureThumbnails({ loadTimeout: 8000, renderTimeout: 20_000 })
    }
  })
})
