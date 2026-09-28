// Scenario 4: the thumbnail queue under a steady rate of publishes (100 a minute by default). Each
// publish is a new, ordinary page, so each needs a render; renders run THUMBNAIL_CONCURRENCY at a time
// (2 by default) in one headless Chromium per server process. A second scenario reads GET /metrics every few seconds and records the
// queue length and how many renders finished, and keeps doing so for DRAIN after publishing stops,
// to see whether the queue empties again.
//
// Needs a server with thumbnails on (CHROME_PATH, set in the Docker image) and METRICS_TOKEN.
import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { Gauge, Trend } from 'k6/metrics'
import { loadSeed, METRICS_TOKEN, seconds } from '../lib/config.js'
import { makeSite, unique } from '../lib/content.js'
import { callTool, slugFrom } from '../lib/mcp.js'
import { scrape, total } from '../lib/metrics.js'

const seed = loadSeed()
const RATE = Number(__ENV.RATE || 100)
const RUN = seconds(__ENV.DURATION || '10m')
const DRAIN = seconds(__ENV.DRAIN || '3m')
const SAMPLE_EVERY = Number(__ENV.SAMPLE_EVERY || 5)

const FAILED = 'artifact_thumbnail_render_duration_seconds_count{outcome="failed"}'

const queueLength = new Trend('thumbnail_queue_length')
const queueNow = new Gauge('thumbnail_queue_now')
const rendered = new Gauge('thumbnails_rendered')
const failed = new Gauge('thumbnails_failed')
const renderSeconds = new Gauge('thumbnail_render_mean_seconds')

export const options = {
  scenarios: {
    publish: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1m',
      duration: `${RUN}s`,
      preAllocatedVUs: 5,
      maxVUs: 50,
      exec: 'publish',
    },
    sampler: { executor: 'constant-vus', vus: 1, duration: `${RUN + DRAIN}s`, exec: 'sample' },
  },
  thresholds: {
    'http_req_failed{scenario:publish}': ['rate<0.01'],
    'checks{scenario:publish}': ['rate>0.99'],
    'http_req_duration{step:publish}': ['p(95)<1000'],
    // The server stops queueing past 1000 (MAX_QUEUE in apps/api/src/thumbnails.ts) and those pages
    // get no thumbnail until someone opens the gallery again
    thumbnail_queue_length: ['max<500', 'p(95)<100'],
    // The queue is empty again by the end of the drain
    thumbnail_queue_now: ['value<1'],
  },
}

// A typical agent page: one document, inline CSS, no network needs while rendering
const site = makeSite({ htmlKb: Number(__ENV.HTML_KB || 30), files: 0, fileKb: 0, title: 'Thumbnail load test' })

export function setup() {
  if (!METRICS_TOKEN) throw new Error('Set METRICS_TOKEN to the token the server was started with, so this can read the queue from /metrics.')
  const first = scrape()
  if (!first) throw new Error('GET /metrics did not answer 200. Is METRICS_TOKEN the one the server has?')
  if (first.artifact_thumbnail_queue_length === undefined) throw new Error('The server reports no thumbnail queue.')
  return { rendered: total(first, 'artifact_thumbnail_render_duration_seconds_count'), failed: first[FAILED] ?? 0 }
}

export function publish() {
  const user = seed.users[exec.vu.idInTest % seed.users.length]
  const content = unique(site, `${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`, false)
  const { res, text, ok } = callTool(
    user.orgToken,
    'publish_artifact',
    { title: `Thumbnail ${exec.scenario.iterationInTest}`, ...content, folder: 'k6 thumbnails' },
    { step: 'publish' },
  )
  check(res, { 'publish 200': (r) => r.status === 200 })
  check(text, { 'published, not refused': () => ok && Boolean(slugFrom(text)) })
}

export function sample(start) {
  const values = scrape()
  if (values) {
    const queue = values.artifact_thumbnail_queue_length
    queueLength.add(queue)
    queueNow.add(queue)
    const count = total(values, 'artifact_thumbnail_render_duration_seconds_count')
    rendered.add(count - start.rendered)
    failed.add((values[FAILED] ?? 0) - start.failed)
    if (count) renderSeconds.add(total(values, 'artifact_thumbnail_render_duration_seconds_sum') / count)
  }
  sleep(SAMPLE_EVERY)
}
