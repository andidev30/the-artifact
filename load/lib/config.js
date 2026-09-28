// Settings every scenario reads from the environment: k6 run -e BASE_URL=... -e VUS=... -e DURATION=...
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8090').replace(/\/$/, '')
export const VUS = Number(__ENV.VUS || 10)
export const DURATION = __ENV.DURATION || '1m'
// Seconds a person waits between two steps; 0 hammers the server as fast as it answers
export const THINK = Number(__ENV.THINK ?? 1)
export const METRICS_TOKEN = __ENV.METRICS_TOKEN || ''

// open() only works while k6 loads the script. It resolves relative paths from the entry script today
// and from the calling module in later k6 versions, hence import.meta.resolve; SEED is best absolute.
export function loadSeed() {
  const path = __ENV.SEED || import.meta.resolve('../seed.json')
  try {
    return JSON.parse(open(path))
  } catch (err) {
    throw new Error(`Can't read the seed file ${path} (${err}). Run pnpm --filter @the-artifact/api load:seed first, or pass -e SEED=<path>.`)
  }
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)]

// "90s", "10m", "1h30m" in seconds, for scenarios whose timings add up
export function seconds(duration) {
  const units = { s: 1, m: 60, h: 3600 }
  let total = 0
  for (const [, n, unit] of duration.matchAll(/(\d+(?:\.\d+)?)([smh])/g)) total += Number(n) * units[unit]
  if (!total) throw new Error(`Write durations like 30s, 10m or 1h, not "${duration}".`)
  return total
}
