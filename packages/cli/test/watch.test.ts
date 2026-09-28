import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Io, main } from '../src/main.ts'
import { type Clock, pollFolder, relevantChange, runWatch, type Subscribe, watchFolder } from '../src/watch.ts'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'artifact-watch-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// Timers that only run when the test moves time on
function fakeClock() {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout(fn, ms) {
      const id = ++next
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id as number)
    },
  }
  async function advance(ms: number) {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
      await settle()
    }
    now = until
    await settle()
  }
  return { clock, advance, pending: () => timers.size }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// Changes reported by hand
function manualChanges() {
  let listener: ((path: string | null) => void) | null = null
  const subscribe: Subscribe = (onChange) => {
    listener = onChange
    return () => {
      listener = null
    }
  }
  return { subscribe, change: (path: string | null) => listener?.(path), listening: () => listener !== null }
}

describe('relevantChange', () => {
  it('ignores what publish leaves out, and the page link file', () => {
    const relevant = relevantChange({ ignore: ['*.map', 'drafts/'] })
    expect(relevant('index.html')).toBe(true)
    expect(relevant('css/site.css')).toBe(true)
    expect(relevant(null)).toBe(true)
    expect(relevant('.env')).toBe(false)
    expect(relevant('.git/index')).toBe(false)
    expect(relevant('assets/.DS_Store')).toBe(false)
    expect(relevant('node_modules/x/index.js')).toBe(false)
    expect(relevant('.the-artifact.json')).toBe(false)
    expect(relevant('app.js.map')).toBe(false)
    expect(relevant('drafts')).toBe(false)
    expect(relevant('drafts/one.html')).toBe(false)
    expect(relevant('')).toBe(false)
  })

  it('only counts the file itself when publishing one HTML file', () => {
    const relevant = relevantChange({ file: 'report.html' })
    expect(relevant('report.html')).toBe(true)
    expect(relevant('other.html')).toBe(false)
    expect(relevant('sub/report.html')).toBe(false)
  })
})

describe('runWatch', () => {
  function setup(publish: () => Promise<void>) {
    const { clock, advance } = fakeClock()
    const changes = manualChanges()
    const errors: unknown[] = []
    const controller = new AbortController()
    const done = runWatch({
      subscribe: changes.subscribe,
      relevant: relevantChange({}),
      publish,
      onError: (err) => errors.push(err),
      signal: controller.signal,
      clock,
    })
    return { advance, changes, errors, controller, done }
  }

  it('publishes once after a burst of changes settles', async () => {
    let published = 0
    const w = setup(async () => {
      published++
    })
    w.changes.change('index.html')
    await w.advance(300)
    w.changes.change('style.css')
    await w.advance(300)
    w.changes.change('.git/HEAD')
    await w.advance(199)
    expect(published).toBe(0)
    await w.advance(1)
    expect(published).toBe(1)
    await w.advance(5000)
    expect(published).toBe(1)
    w.controller.abort()
    await w.done
    expect(w.changes.listening()).toBe(false)
  })

  it('never publishes for ignored files', async () => {
    let published = 0
    const w = setup(async () => {
      published++
    })
    w.changes.change('node_modules/a.js')
    w.changes.change('.the-artifact.json')
    await w.advance(2000)
    expect(published).toBe(0)
    w.controller.abort()
    await w.done
  })

  it('publishes once more for changes made while publishing', async () => {
    let published = 0
    let finish: () => void = () => {}
    const w = setup(
      () =>
        new Promise<void>((resolve) => {
          published++
          finish = resolve
        }),
    )
    w.changes.change('index.html')
    await w.advance(500)
    expect(published).toBe(1)
    w.changes.change('index.html')
    w.changes.change('app.js')
    await w.advance(2000)
    expect(published).toBe(1)
    finish()
    await settle()
    await w.advance(499)
    expect(published).toBe(1)
    await w.advance(1)
    expect(published).toBe(2)
    finish()
    await w.advance(2000)
    expect(published).toBe(2)
    w.controller.abort()
    await w.done
  })

  it('reports a failed publish and keeps watching', async () => {
    let calls = 0
    const w = setup(async () => {
      calls++
      if (calls === 1) throw new Error('offline')
    })
    w.changes.change('index.html')
    await w.advance(500)
    expect(w.errors).toEqual([new Error('offline')])
    w.changes.change('index.html')
    await w.advance(500)
    expect(calls).toBe(2)
    expect(w.errors).toHaveLength(1)
    w.controller.abort()
    await w.done
  })

  it('stops on interrupt, after a publish that is running', async () => {
    let finish: () => void = () => {}
    let published = 0
    const w = setup(
      () =>
        new Promise<void>((resolve) => {
          published++
          finish = resolve
        }),
    )
    w.changes.change('index.html')
    await w.advance(500)
    let stopped = false
    void w.done.then(() => {
      stopped = true
    })
    w.controller.abort()
    await settle()
    expect(stopped).toBe(false)
    w.changes.change('index.html')
    finish()
    await w.advance(2000)
    expect(stopped).toBe(true)
    expect(published).toBe(1)
  })

  it('drops a pending publish on interrupt', async () => {
    let published = 0
    const w = setup(async () => {
      published++
    })
    w.changes.change('index.html')
    w.controller.abort()
    await w.done
    await w.advance(2000)
    expect(published).toBe(0)
  })
})

describe('watching a real folder', () => {
  async function waitFor(check: () => boolean, ms = 5000) {
    const until = Date.now() + ms
    while (!check()) {
      if (Date.now() > until) throw new Error('timed out')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('polls for added, changed and removed files', async () => {
    await writeFile(join(tmp, 'index.html'), 'one')
    const seen: (string | null)[] = []
    const stop = pollFolder(tmp, { relevant: relevantChange({}), interval: 20 })((path) => seen.push(path))
    await new Promise((resolve) => setTimeout(resolve, 60))
    await writeFile(join(tmp, 'index.html'), 'two, longer')
    await mkdir(join(tmp, 'css'))
    await writeFile(join(tmp, 'css/site.css'), 'a')
    await writeFile(join(tmp, '.hidden'), 'x')
    await waitFor(() => seen.includes('index.html') && seen.includes('css/site.css'))
    await rm(join(tmp, 'css/site.css'))
    await waitFor(() => seen.filter((p) => p === 'css/site.css').length === 2)
    stop()
    expect(seen).not.toContain('.hidden')
  })

  it('hears changes with fs.watch, in folders too', async () => {
    await mkdir(join(tmp, 'css'))
    await writeFile(join(tmp, 'index.html'), 'one')
    const seen: (string | null)[] = []
    const stop = watchFolder(tmp, { relevant: relevantChange({}) })((path) => seen.push(path))
    // fs.watch can take a moment to start on some platforms
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(tmp, 'css/site.css'), 'b')
    await waitFor(() => seen.some((p) => p === null || p === 'css/site.css'))
    stop()
  })
})

// A stand-in for the server: POST /api/publish, and /mcp with or without direct uploads
async function fakeServer(opts: { uploads?: boolean; failPublish?: number[] } = {}) {
  const published: { id: string | null; title: string; html: string; visibility: string | null }[] = []
  const stored = new Set<string>()
  const put: string[] = []
  let requests = 0
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }
  const answer = (id: string | null, title: string, visibility: string | null) => {
    const version = published.filter((p) => (p.id ?? 'page1') === (id ?? 'page1')).length
    return { id: 'page1', url: `${origin}/a/page1`, title, version, visibility: visibility ?? 'private', folder: null }
  }
  let origin = ''
  const server: Server = createServer(async (req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const raw = await body(req)
    if (req.url === '/api/publish') {
      requests++
      if (opts.failPublish?.includes(requests)) return json(400, { error: 'This account is past its limit.' })
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: raw }).formData()
      const entry = { id: (form.get('artifact_id') as string) ?? null, title: form.get('title') as string, html: await (form.get('index.html') as File).text() }
      published.push({ ...entry, visibility: (form.get('visibility') as string) ?? null })
      return json(200, answer(entry.id, entry.title, (form.get('visibility') as string) ?? null))
    }
    if (req.url?.startsWith('/upload/')) {
      const hash = req.url.slice('/upload/'.length)
      put.push(hash)
      stored.add(createHash('sha256').update(raw).digest('hex') === hash ? hash : 'mismatch')
      res.writeHead(200)
      return res.end()
    }
    if (req.url === '/mcp') {
      const message = JSON.parse(raw.toString())
      const reply = (result: unknown) => json(200, { jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'tools/list') {
        const tools = opts.uploads ? ['prepare_upload', 'publish_upload'].map((name) => ({ name, inputSchema: {}, outputSchema: {} })) : []
        return reply({ tools })
      }
      const { name, arguments: args } = message.params
      if (name === 'prepare_upload') {
        const files = args.files as { path: string; sha256: string; size: number }[]
        const uploads = files.filter((f) => !stored.has(f.sha256)).map((f) => ({ paths: [f.path], size: f.size, url: `${origin}/upload/${f.sha256}` }))
        return reply({ content: [{ type: 'text', text: 'prepared' }], structuredContent: { upload_id: 'u1', uploads, stored: [] } })
      }
      if (name === 'publish_upload') {
        requests++
        published.push({ id: args.artifact_id ?? null, title: args.title, html: '', visibility: args.visibility ?? null })
        return reply({ content: [{ type: 'text', text: 'ok' }], structuredContent: answer(args.artifact_id ?? null, args.title, args.visibility ?? null) })
      }
    }
    json(404, { error: 'Not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, published, put, close: () => new Promise((resolve) => server.close(resolve)) }
}

describe('publish --watch', () => {
  let server: Awaited<ReturnType<typeof fakeServer>> | null = null

  afterEach(async () => {
    await server?.close()
    server = null
  })

  function watchIo(origin: string) {
    const out = { stdout: '', stderr: '' }
    const controller = new AbortController()
    const changes = manualChanges()
    const io: Io = {
      env: { THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config'), THE_ARTIFACT_URL: origin, THE_ARTIFACT_TOKEN: 'art_test' },
      cwd: tmp,
      stdout: { write: (s: string) => (out.stdout += s) },
      stderr: { write: (s: string) => (out.stderr += s) },
      readStdin: async () => '',
      openBrowser: false,
      interrupted: () => controller.signal,
      watch: { subscribe: () => changes.subscribe, debounceMs: 10 },
    }
    return { io, out, controller, changes }
  }

  async function until(check: () => boolean) {
    const end = Date.now() + 5000
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('publishes, then a new version of the same page after each change, and stops on Ctrl+C', async () => {
    server = await fakeServer({ failPublish: [3] })
    const dir = join(tmp, 'site')
    await mkdir(dir)
    await writeFile(join(dir, 'index.html'), '<title>One</title>')
    const w = watchIo(server.origin)
    const run = main(['publish', 'site', '--watch', '--visibility', 'link', '--save'], w.io)
    await until(() => w.out.stderr.includes('Watching site for changes'))
    expect(server.published).toEqual([{ id: null, title: 'One', html: '<title>One</title>', visibility: 'link' }])
    expect(w.out.stdout).toBe(`${server.origin}/a/page1\n`)

    await writeFile(join(dir, 'index.html'), '<title>Two</title>')
    w.changes.change('index.html')
    await until(() => server!.published.length === 2)
    // The same page, and the visibility is left as it is now
    expect(server.published[1]).toEqual({ id: 'page1', title: 'Two', html: '<title>Two</title>', visibility: null })
    await until(() => w.out.stderr.includes('Published version 2 of "Two"'))

    // Nothing changed: nothing is sent
    w.changes.change('index.html')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.published).toHaveLength(2)

    // The server refuses the third: the message is shown and the watch goes on
    await writeFile(join(dir, 'index.html'), '<title>Three</title>')
    w.changes.change('index.html')
    await until(() => w.out.stderr.includes('This account is past its limit.'))
    w.changes.change('index.html')
    await until(() => server!.published.length === 3)
    expect(server.published[2]).toMatchObject({ id: 'page1', title: 'Three' })

    w.controller.abort()
    expect(await run).toBe(0)
    expect(w.out.stderr).toContain('Stopped watching.')
    expect(w.out.stdout.trim().split('\n')).toHaveLength(3)
  })

  it('keeps watching when the first publish fails, and publishes once the folder is fixed', async () => {
    server = await fakeServer()
    const dir = join(tmp, 'site')
    await mkdir(dir)
    const w = watchIo(server.origin)
    const run = main(['publish', 'site', '--watch'], w.io)
    await until(() => w.out.stderr.includes('Watching site'))
    expect(w.out.stderr).toContain('There is no index.html in site.')
    await writeFile(join(dir, 'index.html'), '<title>Fixed</title>')
    w.changes.change('index.html')
    await until(() => server!.published.length === 1)
    w.controller.abort()
    expect(await run).toBe(0)
  })

  it('uploads only the files that changed when the server takes direct uploads', async () => {
    server = await fakeServer({ uploads: true })
    const dir = join(tmp, 'site')
    await mkdir(dir)
    await writeFile(join(dir, 'index.html'), '<title>One</title><link rel="stylesheet" href="site.css">')
    await writeFile(join(dir, 'site.css'), 'body { color: red }')
    const w = watchIo(server.origin)
    const run = main(['publish', 'site', '--watch'], w.io)
    await until(() => w.out.stderr.includes('Watching site'))
    expect(server.put).toHaveLength(2)

    await writeFile(join(dir, 'site.css'), 'body { color: blue }')
    w.changes.change('site.css')
    await until(() => server!.published.length === 2)
    expect(server.put).toHaveLength(3)
    await until(() => w.out.stderr.includes('Sent 1 of 2 files'))
    w.controller.abort()
    expect(await run).toBe(0)
  })

  it('refuses --watch with --dry-run or --only, and --poll without --watch', async () => {
    const w = watchIo('http://127.0.0.1:9')
    expect(await main(['publish', 'site', '--watch', '--dry-run'], w.io)).toBe(2)
    expect(await main(['publish', 'site', '--poll'], w.io)).toBe(2)
    expect(await main(['publish', 'site', '--watch', '--only', 'data.json'], w.io)).toBe(2)
  })
})
