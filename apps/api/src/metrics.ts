import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { routePath } from 'hono/route'
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client'
import { poolStats } from './db/index.js'
import { log, requestContext } from './log.js'

// Prometheus metrics, served at GET /metrics when METRICS_TOKEN is set (routes/health.ts). Recording
// them is cheap and uses no timers, so it is always on, including on Vercel where nobody scrapes.
export const registry = new Registry()

let defaultsOn = false
// Process metrics (CPU, memory, event loop lag, GC) start on the first scrape: they keep samplers
// running, which a serverless function that is never scraped doesn't need
export function collectProcessMetrics() {
  if (defaultsOn) return
  defaultsOn = true
  collectDefaultMetrics({ register: registry, prefix: 'artifact_' })
}

const httpDuration = new Histogram({
  name: 'artifact_http_request_duration_seconds',
  help: 'HTTP requests by route pattern, method and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
})

export const s3Duration = new Histogram({
  name: 'artifact_s3_request_duration_seconds',
  help: 'Object storage requests by operation and outcome',
  labelNames: ['operation', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

export const thumbnailDuration = new Histogram({
  name: 'artifact_thumbnail_render_duration_seconds',
  help: 'Thumbnail renders by outcome (stored or failed), from loading the page to storing the result',
  labelNames: ['outcome'] as const,
  buckets: [0.5, 1, 2, 3, 5, 8, 13, 20, 30],
  registers: [registry],
})

// Set by thumbnails.ts, which owns the queue
export const thumbnailQueue = new Gauge({
  name: 'artifact_thumbnail_queue_length',
  help: 'Versions waiting for a thumbnail or being rendered',
  registers: [registry],
})

new Gauge({
  name: 'artifact_db_pool_max',
  help: 'Connections the database pool may open',
  registers: [registry],
  collect() {
    this.set(poolStats().max)
  },
})

new Gauge({
  name: 'artifact_db_pool_active',
  help: 'Queries and transactions holding or waiting for a database connection; above artifact_db_pool_max, some are queued',
  registers: [registry],
  collect() {
    this.set(poolStats().active)
  },
})

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
// Anything else a client sends would become an id in the logs and a label value
const REQUEST_ID = /^[\w.:-]{1,128}$/
// Probes and scrapes every few seconds would drown out the rest of the log
const QUIET = new Set(['/healthz', '/readyz', '/metrics'])

// Gives each request an id (the caller's X-Request-Id when it is sane), times it, and logs one line.
// Routes are labelled by their pattern (/api/artifacts/:id), never the path, which holds page ids and
// tokens: that keeps the number of series small and secrets out of the logs.
export const observeRequests: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('x-request-id')
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID()
  const start = performance.now()
  // Hono turns thrown errors into responses before they get back here, so the status is always set
  await requestContext.run({ requestId }, next)
  const seconds = (performance.now() - start) / 1000
  const status = c.res.status
  const method = METHODS.has(c.req.method) ? c.req.method : 'OTHER'
  // The pattern of the route that answered; with none matched, it is this middleware's own '*'
  const route = routePath(c)
  httpDuration.observe({ method, route, status: String(status) }, seconds)
  if (!(QUIET.has(route) && status < 400)) {
    log[status >= 500 ? 'error' : 'info']('request', { requestId, method, route, status, durationMs: Math.round(seconds * 10_000) / 10 })
  }
  c.header('X-Request-Id', requestId)
}
