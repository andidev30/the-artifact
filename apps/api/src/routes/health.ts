import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/index.js'
import { env } from '../env.js'
import { log } from '../log.js'
import { collectProcessMetrics, metricsText, registry } from '../metrics.js'
import { checkBucket } from '../storage.js'
import { bearerMatches } from './cron.js'

// Probes for load balancers and orchestrators, and the Prometheus scrape endpoint. They sit outside
// /api so a probe never runs the session lookup, and they work the same on every host.
export const health = new Hono()

// A check that takes longer than this counts as failing, well inside the usual probe timeouts
const CHECK_TIMEOUT_MS = 2_000

// The process is up and answering. Nothing else, so a database outage doesn't get the pod restarted.
health.get('/healthz', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

type Readiness = { ready: boolean; checks: { database: 'ok' | 'failing'; storage: 'ok' | 'failing' } }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function passes(name: string, run: () => Promise<unknown>): Promise<'ok' | 'failing'> {
  try {
    await withTimeout(run(), CHECK_TIMEOUT_MS)
    return 'ok'
  } catch (err) {
    // The reason goes to the log only: the response is public and shouldn't describe the internals
    log.warn('Readiness check failed', { check: name, error: err instanceof Error ? err.message : String(err) })
    return 'failing'
  }
}

// Probes arriving together share one round of checks, so a burst of them costs one query
let running: Promise<Readiness> | null = null

function checkReadiness(): Promise<Readiness> {
  running ??= (async () => {
    const [database, storage] = await Promise.all([passes('database', () => db.execute(sql`select 1`)), passes('storage', () => checkBucket(CHECK_TIMEOUT_MS))])
    return { ready: database === 'ok' && storage === 'ok', checks: { database, storage } }
  })().finally(() => {
    running = null
  })
  return running
}

// Postgres and object storage answer, so the app can serve requests
health.get('/readyz', async (c) => {
  const { ready, checks } = await checkReadiness()
  c.header('Cache-Control', 'no-store')
  return c.json({ status: ready ? 'ok' : 'unavailable', checks }, ready ? 200 : 503)
})

// Only with METRICS_TOKEN set, and only for requests that send it as a bearer token. Otherwise it
// answers like any missing path, so an install doesn't reveal that it has one.
health.get('/metrics', async (c) => {
  if (!bearerMatches(c.req.header('authorization'), env.metricsToken)) return c.json({ error: 'Not found' }, 404)
  collectProcessMetrics()
  c.header('Cache-Control', 'no-store')
  return c.body(await metricsText(), 200, { 'Content-Type': registry.contentType })
})
