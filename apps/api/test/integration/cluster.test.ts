import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'

// The built server with WEB_CONCURRENCY=2, as the Docker image runs it: a primary and two workers
// sharing one port. Every other test runs the app in-process, as one process.
const API = fileURLToPath(new URL('../..', import.meta.url))
// Inside node_modules, so the build finds its dependencies
const OUT = fileURLToPath(new URL('../../node_modules/.cache/cluster-test', import.meta.url))

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
  await rm(OUT, { recursive: true, force: true })
  await promisify(execFile)(fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url)), ['--outDir', OUT], { cwd: API })
  child = spawn(process.execPath, [`${OUT}/index.js`], {
    cwd: API,
    env: { ...process.env, WEB_CONCURRENCY: '2', PORT: '0', METRICS_TOKEN: 'cluster-test', MIGRATE_ON_START: 'false', DATABASE_POOL_MAX: '' },
  })
  child.stdout?.on('data', (d) => {
    output += d
  })
  child.stderr?.on('data', (d) => {
    output += d
  })
  exit = new Promise((resolve) => child.on('exit', resolve))
}, 60_000)

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

  child.kill('SIGTERM')
  expect(await exit).toBe(0)
  expect(lines().filter((l) => l.msg === 'Stopped')).toHaveLength(3)
  expect(lines().filter((l) => l.level === 'error')).toEqual([])
}, 60_000)
