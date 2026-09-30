import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { closeThumbnailBrowser, configureThumbnails, renderPage } from '../../src/thumbnails.js'
import { createToken } from '../../src/tokens.js'
import { createPage, createUser } from './helpers.js'

// The built server with WEB_CONCURRENCY=2, as the Docker image runs it: a primary and two workers
// sharing one port. Every other test runs the app in-process, as one process.
const API = fileURLToPath(new URL('../..', import.meta.url))
// Inside node_modules, so the build finds its dependencies
const OUT = fileURLToPath(new URL('../../node_modules/.cache/cluster-test', import.meta.url))

// With Chrome, the workers render thumbnails, inspections and PDFs as in production
const CHROME = process.env.TEST_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = existsSync(CHROME)

let child: ChildProcess
let output = ''
let exit: Promise<number | null>

const lines = () =>
  output
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)

async function until<T>(find: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const found = find()
    if (found !== undefined) return found
    if (Date.now() > end) throw new Error(`No ${what} within ${ms} ms. Output:\n${output}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  if (hasChrome) {
    // A cold Chrome start can take longer than the server's launch timeout (see thumbnails.test.ts)
    configureThumbnails({ chromePath: CHROME, launchTimeout: 60_000 })
    await renderPage({ html: '<h1>warm</h1>', files: [] })
    await closeThumbnailBrowser()
    configureThumbnails({ chromePath: '', launchTimeout: 15_000 })
  }
  await rm(OUT, { recursive: true, force: true })
  await promisify(execFile)(fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url)), ['--outDir', OUT], { cwd: API })
  child = spawn(process.execPath, [`${OUT}/index.js`], {
    cwd: API,
    env: {
      ...process.env,
      WEB_CONCURRENCY: '2',
      PORT: '0',
      METRICS_TOKEN: 'cluster-test',
      MIGRATE_ON_START: 'false',
      DATABASE_POOL_MAX: '',
      CHROME_PATH: hasChrome ? CHROME : '',
    },
  })
  child.stdout?.on('data', (d) => {
    output += d
  })
  child.stderr?.on('data', (d) => {
    output += d
  })
  exit = new Promise((resolve) => child.on('exit', resolve))
}, 120_000)

afterAll(async () => {
  if (child.exitCode === null) child.kill('SIGKILL')
  await rm(OUT, { recursive: true, force: true })
})

it('serves from two workers, runs the background jobs in one, and stops on SIGTERM', async () => {
  const running = await until(() => {
    const found = lines().filter((l) => l.msg === 'Server is running')
    return found.length === 2 ? found : undefined
  }, 'two workers')
  expect(new Set(running.map((l) => l.worker)).size).toBe(2)
  // Listening on port 0, the workers share the one port the primary picked
  expect(running[0].port).toBe(running[1].port)
  const origin = `http://127.0.0.1:${running[0].port}`

  for (let i = 0; i < 20; i++) expect((await fetch(`${origin}/api/config`)).status).toBe(200)

  const metrics = await (await fetch(`${origin}/metrics`, { headers: { Authorization: 'Bearer cluster-test' } })).text()
  // Added up over both workers: two pools of 10, and every request whichever worker answered it
  expect(metrics).toMatch(/^artifact_db_pool_max 20$/m)
  expect(metrics).toMatch(/^artifact_http_request_duration_seconds_count\{method="GET",route="\/api\/config",status="200"\} 20$/m)

  // The storage sweep and the thumbnail queue: one worker for the whole server
  expect(lines().filter((l) => l.msg === 'Background jobs run in this worker')).toHaveLength(1)

  if (hasChrome) {
    // Inspections on a new connection each, so both workers take some: the one without Chromium
    // asks the background worker through the primary and passes its answer on
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Clustered' })
    const { token } = await createToken({ userId: owner.id, organizationId: null, name: 'cluster', expiresAt: null })
    const answers = await Promise.all(Array.from({ length: 4 }, (_, i) => inspect(origin, token, page.slug, i)))
    for (const answer of answers) {
      expect(answer.text).toContain('Inspected version 1 of "Clustered"')
      expect(answer.images).toBe(1)
    }
    // PDFs go the same way
    const shared = await createPage(owner, { title: 'Printed', visibility: 'link' })
    const pdfs = await Promise.all(Array.from({ length: 4 }, () => pdf(origin, shared.slug)))
    for (const printed of pdfs) expect(printed).toEqual({ status: 200, start: '%PDF-' })
  }

  child.kill('SIGTERM')
  expect(await exit).toBe(0)
  expect(lines().filter((l) => l.msg === 'Stopped')).toHaveLength(3)
  expect(lines().filter((l) => l.level === 'error')).toEqual([])
}, 120_000)

// A PDF of a link-shared page on a connection of its own, like the MCP calls below
function pdf(origin: string, slug: string): Promise<{ status: number; start: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${origin}/api/artifacts/${slug}/pdf`, { agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, start: Buffer.concat(chunks).subarray(0, 5).toString('latin1') }))
    })
    req.on('error', reject)
    req.end()
  })
}

// One MCP tool call on a connection of its own, which the primary hands to the next worker in turn
function inspect(origin: string, token: string, slug: string, id: number): Promise<{ text: string; images: number }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'inspect_artifact', arguments: { artifact_id: slug } } })
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}/mcp`,
      {
        method: 'POST',
        agent: false,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          const content = (JSON.parse(data) as { result: { content: { type: string; text?: string }[] } }).result.content
          resolve({ text: content.map((c) => c.text ?? '').join('\n'), images: content.filter((c) => c.type === 'image').length })
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
