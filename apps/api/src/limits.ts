import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { db, schema } from './db/index.js'
import { env } from './env.js'

// Rate limits: at most `max` hits per key in a window that starts at the first hit. The counters live
// in Postgres (the rate_limits table), because the hosted service runs as many short-lived serverless
// instances and a self-hosted install may run several replicas; memory would count each one apart.

const MINUTE = 60
const HOUR = 60 * MINUTE

export type Rule = { max: number; seconds: number }

// docs/configuration.md lists these with their defaults; change both together
const CORE = {
  // Sign-in links emailed to one address (on top of one per 60 seconds, see src/auth/email.ts)
  'sign-in-link': { max: 10, seconds: HOUR },
  'sign-in-link-ip': { max: 30, seconds: HOUR },
  // Wrong passwords for one address, at sign-in or when changing the password; a right one clears the count
  password: { max: 10, seconds: 15 * MINUTE },
  // Password sign-in, sign-up and setup attempts from one address
  'password-ip': { max: 100, seconds: 15 * MINUTE },
  // Wrong authenticator app and recovery codes for one account, at sign-in or while setting the app up; a right one clears the count
  'two-factor': { max: 10, seconds: HOUR },
  // Second-factor steps and passkey sign-ins from one address
  'two-factor-ip': { max: 100, seconds: 15 * MINUTE },
  // Passkeys, authenticator app set-ups and new recovery codes one account asks for
  'two-factor-setup': { max: 30, seconds: HOUR },
  'oauth-register-ip': { max: 60, seconds: HOUR },
  // People one account invites to an organization or shares a page with
  invite: { max: 200, seconds: HOUR },
  'invite-ip': { max: 500, seconds: HOUR },
  // MCP tool calls by one account, and the ones among them (or through POST /api/publish) that publish a version
  mcp: { max: 600, seconds: 10 * MINUTE },
  publish: { max: 200, seconds: HOUR },
  // Pages one account has rendered on the server with inspect_artifact (each takes a few seconds of Chromium)
  inspect: { max: 100, seconds: HOUR },
  // Access tokens one account creates in settings
  'access-token': { max: 20, seconds: HOUR },
  // Comments and replies one account writes, in the app or through agents
  comment: { max: 120, seconds: HOUR },
  // Wrong passwords for one link-shared page, from anyone; a right one takes its own try back
  'link-password': { max: 30, seconds: 15 * MINUTE },
  // Link password attempts from one address, right or wrong
  'link-password-ip': { max: 100, seconds: 15 * MINUTE },
  // Emails about new comments to one person for one page; comments past it only show in the app
  'comment-email': { max: 1, seconds: 15 * MINUTE },
} satisfies Record<string, Rule>

const defaults = new Map<string, Rule>(Object.entries(CORE))

// For limits of routes outside core (ee/), called as their module loads
export function defineLimit(name: string, rule: Rule) {
  defaults.set(name, rule)
}

const UNITS: Record<string, number> = { s: 1, m: MINUTE, h: HOUR, d: 24 * HOUR }

// RATE_LIMITS: empty for the defaults, "off" for none, or a comma-separated list of changes such as
// "sign-in-link=20/1h,mcp=1000/10m,invite-ip=off"
export function parseRateLimits(value: string): Map<string, Rule | null> {
  const rules = new Map<string, Rule | null>(defaults)
  const s = value.trim().toLowerCase()
  if (!s) return rules
  if (s === 'off' || s === 'false' || s === '0') {
    for (const name of rules.keys()) rules.set(name, null)
    return rules
  }
  for (const part of s.split(',')) {
    const [name, setting = ''] = part.split('=').map((p) => p.trim())
    if (!name) continue
    if (!rules.has(name)) throw new Error(`RATE_LIMITS: there is no limit called "${name}". The limits are ${[...rules.keys()].join(', ')}.`)
    if (setting === 'off') {
      rules.set(name, null)
      continue
    }
    const m = /^(\d+)\/(\d*)([smhd])$/.exec(setting)
    const max = Number(m?.[1])
    const seconds = Number(m?.[2] || 1) * UNITS[m?.[3] ?? 's']
    if (!m || max < 1 || seconds < 1) throw new Error(`RATE_LIMITS: write ${name} as a number per window, like ${name}=20/1h (s, m, h or d), or ${name}=off.`)
    rules.set(name, { max, seconds })
  }
  return rules
}

// Parsed again only when the setting changes (tests change env)
let parsed: { from: string; rules: Map<string, Rule | null> } | null = null

function rules() {
  if (parsed?.from !== env.rateLimits) parsed = { from: env.rateLimits, rules: parseRateLimits(env.rateLimits) }
  return parsed.rules
}

// Called once every limit is defined (src/app.ts), so a mistake in RATE_LIMITS stops the server from starting
export function checkRateLimits() {
  parsed = null
  rules()
}

export function rule(name: string): Rule | null {
  const r = rules().get(name)
  if (r === undefined) throw new Error(`No rate limit called "${name}"`)
  return r
}

// Whole seconds until the window resets, at least 1, for Retry-After
const WAIT = sql.raw('greatest(1, ceil(extract(epoch from resets_at - now())))::int')

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

// Counts `cost` hits for the key. Returns null while within the limit, otherwise the seconds until it resets.
export async function hit(name: string, key: string, cost = 1): Promise<number | null> {
  const r = rule(name)
  if (!r) return null
  // One statement, so two requests at once can't both see the old count. The window restarts when
  // the old one is over. What would go past the limit isn't counted (the update's where fails and
  // nothing is returned), so asking to invite 20 people when 5 are left doesn't use up those 5.
  // Times come from the database, so every instance agrees on them.
  const [row] = await db.execute<{ hits: number; wait: number }>(sql`
    insert into ${schema.rateLimits} (bucket, key, hits, resets_at)
    values (${name}, ${hashKey(key)}, ${cost}, now() + make_interval(secs => ${r.seconds}))
    on conflict (bucket, key) do update set
      hits = case when rate_limits.resets_at <= now() then excluded.hits else rate_limits.hits + excluded.hits end,
      resets_at = case when rate_limits.resets_at <= now() then excluded.resets_at else rate_limits.resets_at end
    where rate_limits.resets_at <= now() or rate_limits.hits + excluded.hits <= ${r.max}
    returning hits, ${WAIT} as wait`)
  if (row && row.hits <= r.max) return null
  if (row) return row.wait
  const [current] = await db.execute<{ wait: number }>(sql`select ${WAIT} as wait from ${schema.rateLimits} where bucket = ${name} and key = ${hashKey(key)}`)
  return current?.wait ?? 1
}

// For limits that count only failures (wrong passwords and codes): count the attempt with hit before
// checking it, then clearHits or refund once it turns out right. Counting after the check would let
// many requests sent at once all be checked before any of them is counted.

// Takes back one hit, for an attempt that turned out right where a right one shouldn't clear the count
export async function refund(name: string, key: string) {
  await db.execute(sql`
    update ${schema.rateLimits} set hits = greatest(hits - 1, 0)
    where bucket = ${name} and key = ${hashKey(key)} and resets_at > now()`)
}

export async function clearHits(name: string, key: string) {
  await db.delete(schema.rateLimits).where(and(eq(schema.rateLimits.bucket, name), eq(schema.rateLimits.key, hashKey(key))))
}

// Run with the storage sweep; rows whose window is over only matter again once their key comes back
export async function deleteExpiredLimits(): Promise<number> {
  const rows = await db.execute(sql`delete from ${schema.rateLimits} where resets_at < now() returning 1`)
  return rows.length
}

function plural(n: number, unit: string) {
  return n === 1 ? `1 ${unit}` : `${n} ${unit}s`
}

// "4 minutes", for "Try again in …"
export function waitText(seconds: number): string {
  if (seconds < MINUTE) return plural(seconds, 'second')
  const minutes = Math.ceil(seconds / MINUTE)
  if (minutes < 2 * MINUTE) return plural(minutes, 'minute')
  return plural(Math.ceil(minutes / MINUTE), 'hour')
}

// "hour" or "10 minutes", for "per …"
export function windowText(seconds: number): string {
  for (const [unit, size] of [
    ['day', 24 * HOUR],
    ['hour', HOUR],
    ['minute', MINUTE],
  ] as const) {
    if (seconds % size === 0) return seconds === size ? unit : plural(seconds / size, unit)
  }
  return plural(seconds, 'second')
}

export function tooManyRequests(c: Context, error: string, wait: number, extra: Record<string, string> = {}) {
  return c.json({ error, ...extra }, 429, { 'Retry-After': String(wait) })
}

// Counts one request for the key; past the limit, the 429 to answer with. A null key (no client
// address known) isn't limited.
export async function limitRequest(c: Context, name: string, key: string | null, message: string, cost = 1): Promise<Response | null> {
  if (key === null) return null
  const wait = await hit(name, key, cost)
  return wait === null ? null : tooManyRequests(c, `${message} Try again in ${waitText(wait)}.`, wait)
}

// Invitations and shares both email people, so they count together: per account, and per network
export async function limitInvites(c: Context, userId: string, people: number): Promise<Response | null> {
  return (
    (await limitRequest(c, 'invite', userId, 'You have invited a lot of people in a short time.', people)) ??
    (await limitRequest(c, 'invite-ip', clientIp(c), 'Too many invitations were sent from your network.', people))
  )
}

// Without brackets or a zone id, and IPv4-mapped addresses as plain IPv4
export function plainIp(raw: string): string {
  const ip = raw
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .split('%')[0]
  return /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1] ?? ip
}

// IPv4-mapped addresses as plain IPv4, and IPv6 by its /64, which usually belongs to one household or server
export function normalizeIp(raw: string): string {
  const ip = plainIp(raw)
  if (isIP(ip) !== 6) return ip
  const [head, tail] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

// The client's address. Behind TRUST_PROXY proxies, the entry the outermost of them added to
// X-Forwarded-For; entries further left come from the client and could say anything. Otherwise the
// connection's own address, which Node gives and in-process requests (tests) don't have.
export function clientAddress(c: Context): string | null {
  if (env.trustProxy > 0) {
    const hops = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const ip = hops[Math.max(0, hops.length - env.trustProxy)]
    if (ip) return plainIp(ip)
  }
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  return socket ? plainIp(socket) : null
}

// The client's address as rate limits count it: IPv6 by its /64
export function clientIp(c: Context): string | null {
  const ip = clientAddress(c)
  return ip ? normalizeIp(ip) : null
}
