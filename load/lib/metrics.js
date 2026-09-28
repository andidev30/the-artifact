import http from 'k6/http'
import { BASE_URL, METRICS_TOKEN } from './config.js'

// Prometheus text from GET /metrics as { 'name{labels}': value }. Needs METRICS_TOKEN, the same one the
// server was started with. Tagged so these requests can be told apart from the traffic under test.
export function scrape() {
  const res = http.get(`${BASE_URL}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` }, tags: { step: 'metrics' } })
  if (res.status !== 200) return null
  const values = {}
  for (const line of res.body.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const space = line.lastIndexOf(' ')
    values[line.slice(0, space)] = Number(line.slice(space + 1))
  }
  return values
}

// Sum of every series of one metric, whatever its labels, e.g. all outcomes of a counter
export function total(values, name) {
  let sum = 0
  for (const key in values) if (key === name || key.startsWith(`${name}{`)) sum += values[key]
  return sum
}
