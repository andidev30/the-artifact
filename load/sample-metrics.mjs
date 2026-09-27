// Samples GET /metrics during a load test and prints one CSV line per interval, for runs without a
// Prometheus. Rates and means are over the interval since the line before.
//   node load/sample-metrics.mjs --url http://localhost:8090 --token "$METRICS_TOKEN" --every 5 > metrics.csv
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.BASE_URL ?? 'http://localhost:8090' },
    token: { type: 'string', default: process.env.METRICS_TOKEN ?? '' },
    every: { type: 'string', default: '5' },
  },
})
if (!args.token) {
  console.error('Pass --token (or METRICS_TOKEN): the METRICS_TOKEN the server was started with.')
  process.exit(1)
}
const every = Number(args.every) * 1000

async function scrape() {
  const res = await fetch(`${args.url.replace(/\/$/, '')}/metrics`, { headers: { authorization: `Bearer ${args.token}` } })
  if (!res.ok) throw new Error(`GET /metrics answered ${res.status}`)
  const values = new Map()
  for (const line of (await res.text()).split('\n')) {
    if (!line || line.startsWith('#')) continue
    const space = line.lastIndexOf(' ')
    values.set(line.slice(0, space), Number(line.slice(space + 1)))
  }
  return values
}

// Every series of one metric, optionally only those whose labels contain `labels`
function sum(values, name, labels = '') {
  let total = 0
  for (const [key, value] of values) {
    if ((key === name || key.startsWith(`${name}{`)) && key.includes(labels)) total += value
  }
  return total
}

const COLUMNS = [
  'time',
  'requests_per_s',
  'request_mean_ms',
  'errors_5xx_per_s',
  's3_mean_ms',
  'db_pool_active',
  'db_pool_max',
  'thumbnail_queue',
  'thumbnails_per_min',
  'thumbnail_mean_s',
  'cpu_percent',
  'event_loop_lag_p99_ms',
  'rss_mb',
  'heap_used_mb',
]
console.log(COLUMNS.join(','))

let before = await scrape()
let at = Date.now()
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, every))
  let now
  try {
    now = await scrape()
  } catch (err) {
    console.error(String(err))
    continue
  }
  const s = (Date.now() - at) / 1000
  const delta = (name, labels) => sum(now, name, labels) - sum(before, name, labels)
  const mean = (base) => {
    const n = delta(`${base}_count`)
    return n ? delta(`${base}_sum`) / n : 0
  }
  const requests = delta('artifact_http_request_duration_seconds_count')
  const renders = delta('artifact_thumbnail_render_duration_seconds_count')
  const row = [
    new Date().toISOString(),
    (requests / s).toFixed(1),
    (mean('artifact_http_request_duration_seconds') * 1000).toFixed(1),
    (delta('artifact_http_request_duration_seconds_count', 'status="5') / s).toFixed(2),
    (mean('artifact_s3_request_duration_seconds') * 1000).toFixed(1),
    sum(now, 'artifact_db_pool_active'),
    sum(now, 'artifact_db_pool_max'),
    sum(now, 'artifact_thumbnail_queue_length'),
    ((renders / s) * 60).toFixed(1),
    mean('artifact_thumbnail_render_duration_seconds').toFixed(2),
    ((delta('artifact_process_cpu_seconds_total') / s) * 100).toFixed(0),
    (sum(now, 'artifact_nodejs_eventloop_lag_p99_seconds') * 1000).toFixed(1),
    (sum(now, 'artifact_process_resident_memory_bytes') / 1024 / 1024).toFixed(0),
    (sum(now, 'artifact_nodejs_heap_size_used_bytes') / 1024 / 1024).toFixed(0),
  ]
  console.log(row.join(','))
  before = now
  at = Date.now()
}
