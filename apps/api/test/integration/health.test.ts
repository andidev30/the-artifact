import { DrizzleQueryError, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db, poolStats } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { checkBucket } from '../../src/storage.js'
import { call, createPage, createUser } from './helpers.js'

vi.mock('../../src/storage.js', async (original) => {
  const actual = await original<typeof import('../../src/storage.js')>()
  return { ...actual, checkBucket: vi.fn(actual.checkBucket) }
})

describe('health checks', () => {
  it('/healthz answers while the process is up', async () => {
    const res = await call('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('/readyz checks the database and object storage', async () => {
    const res = await call('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } })
  })

  it('/readyz fails without saying why', async () => {
    vi.mocked(checkBucket).mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:9000'))
    const res = await call('/readyz')
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'unavailable', checks: { database: 'ok', storage: 'failing' } })
    expect(text).not.toContain('10.0.0.7')
  })

  it('/readyz gives up on a check that hangs', async () => {
    vi.mocked(checkBucket).mockImplementationOnce(() => new Promise(() => {}))
    const started = Date.now()
    const res = await call('/readyz')
    expect(res.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(4_000)
  })
})

describe('unexpected errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('are logged in the JSON format without query parameters, and answer a plain 500', async () => {
    const user = await createUser()
    const printed: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      printed.push(String(line))
    })
    const cause = Object.assign(new Error('connection lost'), { code: '08006' })
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new DrizzleQueryError('select "id" from "sessions" where "id" = $1', ['secret-session-value'], cause)
    })

    const res = await call('/api/me', { cookie: user.cookie })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Something went wrong. Try again in a moment.' })
    expect(printed.join('\n')).not.toContain('secret-session-value')
    const entry = printed.map((l) => JSON.parse(l)).find((l) => l.msg === 'unhandled error')
    expect(entry).toMatchObject({
      level: 'error',
      requestId: res.headers.get('x-request-id'),
      error: 'connection lost',
      code: '08006',
      query: 'select "id" from "sessions" where "id" = $1',
    })
  })

  it('refuse control characters in titles and names with a 400', async () => {
    const user = await createUser()
    const page = await createPage(user)
    const res = await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: user.cookie, json: { title: 'secret\u0000value' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "The name can't contain control characters.", field: 'title' })
    const named = await call('/api/me', { method: 'PATCH', cookie: user.cookie, json: { name: 'Ada\u001bLovelace' } })
    expect(named.status).toBe(400)
    expect(await named.json()).toMatchObject({ field: 'name' })
    expect((await call('/api/artifacts?q=%00', { cookie: user.cookie })).status).toBe(200)
  })
})

describe('request ids', () => {
  it('are made up when the request has none', async () => {
    const res = await call('/api/config')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("keep the caller's, unless it isn't a plain id", async () => {
    expect((await call('/healthz', { headers: { 'x-request-id': 'lb-1234.abc' } })).headers.get('x-request-id')).toBe('lb-1234.abc')
    const odd = await call('/healthz', { headers: { 'x-request-id': 'a b","level":"error' } })
    expect(odd.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('metrics', () => {
  afterEach(() => {
    env.metricsToken = ''
  })

  it("don't exist without METRICS_TOKEN", async () => {
    expect((await call('/metrics')).status).toBe(404)
    expect((await call('/metrics', { bearer: '' })).status).toBe(404)
  })

  it('need the token as a bearer token', async () => {
    env.metricsToken = 'a-long-random-token'
    expect((await call('/metrics')).status).toBe(404)
    expect((await call('/metrics', { bearer: 'wrong' })).status).toBe(404)
    expect((await call('/metrics', { headers: { authorization: 'a-long-random-token' } })).status).toBe(404)
    expect((await call('/metrics', { bearer: 'a-long-random-token' })).status).toBe(200)
  })

  it('label requests by route pattern, not by path', async () => {
    env.metricsToken = 'a-long-random-token'
    const owner = await createUser()
    const page = await createPage(owner)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie })).status).toBe(200)
    await call('/readyz')

    const res = await call('/metrics', { bearer: 'a-long-random-token' })
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toContain('artifact_http_request_duration_seconds_count{method="GET",route="/api/artifacts/:slug",status="200"}')
    expect(text).not.toContain(page.slug)
    expect(text).toMatch(/artifact_s3_request_duration_seconds_count\{operation="HeadBucket",outcome="ok"\} \d+/)
    expect(text).toMatch(/artifact_db_pool_max \d+/)
    expect(text).toContain('artifact_db_pool_active')
    expect(text).toContain('artifact_thumbnail_queue_length 0')
    expect(text).toContain('artifact_thumbnail_render_duration_seconds')
    expect(text).toContain('artifact_process_cpu_seconds_total')
  })

  it('count database work only while it holds a connection', async () => {
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select pg_sleep(0.05)`)])
    await db.transaction(async (tx) => {
      expect(poolStats().active).toBeGreaterThanOrEqual(1)
      await tx.execute(sql`select 1`)
    })
    await db.execute(sql`select nonexistent_column`).catch(() => {})
    expect(poolStats().active).toBe(0)
  })
})
