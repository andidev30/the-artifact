import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import type { Artifact, Webhook, WebhookDelivery } from './db/schema.js'
import { env, isProduction } from './env.js'
import { hit } from './limits.js'
import { log } from './log.js'
import { isPublicAddress } from './network.js'
import { seal, unseal } from './secrets.js'

// Webhooks: a workspace (an organization, or a person's personal workspace) tells a URL of its choice
// when a page is published, commented on or opened.
//
// Events are queued as rows of webhook_deliveries, so any process can add one, one process sends
// them, and retries survive a restart. Sending happens in one of two ways:
// - Queued (the long-running server: src/server.ts calls useWebhookQueue in every worker, and the
//   background worker runs runWebhookQueue every POLL_MS). Requests only add rows.
// - Inline (the default, and so on Vercel, whose entry api/index.js has no background process): the
//   first attempt is made right away, after the response where the host lets work outlive it
//   (Vercel's waitUntil), otherwise awaited within the request. Retries wait for the next
//   /api/cron/webhooks or /api/cron/sweep, so on a daily schedule they are a day apart.
//
// A request this server makes on a workspace's behalf must not reach anything private: the address
// is resolved first, every address it resolves to must be public (src/network.ts, as for thumbnails),
// the connection is pinned to the address that was checked, and redirects are never followed.

export const WEBHOOK_EVENTS = ['page.published', 'comment.created', 'page.opened'] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]
export const WEBHOOK_FORMATS = ['json', 'slack', 'discord'] as const
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number]
// Sent by "Send a test"; never retried
export const TEST_EVENT = 'webhook.test'

export const MAX_WEBHOOKS = 20
export const MAX_URL_LENGTH = 2000
export const DELIVERY_RETENTION_DAYS = 14
export const TIMEOUT_MS = 5_000
// Waits after each failed attempt: six attempts over a little more than an hour
export const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 40 * 60_000]
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
// An attempt that started this long ago and never finished (the process died) is made again
const LEASE_MS = 60_000
const BATCH = 20
const MAX_BATCHES = 10
export const POLL_MS = 5_000
const EXCERPT_LENGTH = 200
const SECRET_KEY = 'webhook-secrets'

// Hostnames plain http may go to, and only outside production (APP_URL on http), for trying
// webhooks against a local receiver
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

type Resolved = { address: string; family: number }
type Config = { lookup: (host: string) => Promise<Resolved[]>; allowLocalHttp: boolean }

const DEFAULTS: Config = {
  lookup: (host) => lookup(host, { all: true, verbatim: true }),
  allowLocalHttp: !isProduction,
}
let config = DEFAULTS

// For tests: a resolver that answers what they need, and whether local http is allowed; null goes back to the defaults
export function configureWebhooks(next: Partial<Config> | null) {
  config = next ? { ...config, ...next } : DEFAULTS
}

export class WebhookError extends Error {}

// A destination people may save: https (http only to this machine outside production), no
// credentials in it, and not an address that is private on its face. Names are checked again, after
// resolving them, every time something is sent.
export function checkWebhookUrl(value: unknown): { url: string } | { error: string } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return { error: 'Enter the address to send events to.' }
  if (raw.length > MAX_URL_LENGTH) return { error: `Keep the address under ${MAX_URL_LENGTH} characters.` }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: 'Enter a full address, starting with https://.' }
  }
  if (url.username || url.password) return { error: 'Leave the user name and password out of the address.' }
  const local = url.protocol === 'http:' && config.allowLocalHttp && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !local) return { error: 'Use an https:// address.' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!local && (isIP(host) ? !isPublicAddress(host) : host === 'localhost' || host.endsWith('.localhost')))
    return { error: 'That address is on a private network, which webhooks can’t reach.' }
  url.hash = ''
  return { url: url.toString() }
}

export function newSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

export const sealWebhookSecret = (secret: string) => seal(SECRET_KEY, Buffer.from(secret, 'utf8'))
const openWebhookSecret = async (sealed: string) => (await unseal(SECRET_KEY, sealed)).toString('utf8')

// X-Artifact-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
export function signature(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

export type Payload = {
  event: WebhookEvent | typeof TEST_EVENT
  occurredAt: string
  workspace: { type: 'organization'; id: string; name: string } | { type: 'personal'; name: string }
  page?: { id: string; title: string; url: string }
  version?: number
  actor?: { name: string | null } | null
  comment?: { id: string; excerpt: string }
}

// Page content, emails, link keys and passwords never go in: the page's plain address is the app's
// link, which opens for anyone only when the page is shared by link without a key or password
function pageOf(artifact: Artifact) {
  return { id: artifact.slug, title: artifact.title, url: `${env.appUrl}/a/${artifact.slug}` }
}

export function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat
}

// Slack reads &, < and > as markup in text, and <url|label> as a link
const slackText = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
// Discord reads Markdown, and [label](url) as a link
const discordText = (s: string) => s.replace(/([\\`*_~|[\]()<>#@:-])/g, '\\$1')

function message(p: Payload, link: (label: string, url: string) => string, text: (s: string) => string): string {
  const who = text(p.actor?.name || 'Someone')
  const page = p.page ? link(p.page.title, p.page.url) : ''
  const where = text(p.workspace.name)
  switch (p.event) {
    case 'page.published':
      return p.version && p.version > 1 ? `${who} published version ${p.version} of ${page} in ${where}` : `${who} published ${page} in ${where}`
    case 'comment.created':
      return `${who} commented on ${page}: ${text(`“${p.comment?.excerpt ?? ''}”`)}`
    case 'page.opened':
      return `${who} opened ${page}`
    default:
      return `Test message from The Artifact for ${where}. This webhook works.`
  }
}

export function render(format: string, p: Payload): string {
  if (format === 'slack') return JSON.stringify({ text: message(p, (label, url) => `<${url}|${slackText(label)}>`, slackText) })
  if (format === 'discord')
    return JSON.stringify({
      content: message(p, (label, url) => `[${discordText(label)}](${url})`, discordText).slice(0, 2000),
      allowed_mentions: { parse: [] },
    })
  return JSON.stringify(p)
}

type Input = { event: WebhookEvent; artifact: Artifact; version: number; actorId: string | null; comment?: { id: string; body: string } }

async function workspaceOf(artifact: Artifact): Promise<Payload['workspace']> {
  if (!artifact.organizationId) return { type: 'personal', name: 'Personal' }
  const [org] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, artifact.organizationId))
  return { type: 'organization', id: artifact.organizationId, name: org?.name ?? '' }
}

async function actorOf(id: string | null): Promise<Payload['actor']> {
  if (!id) return null
  const [user] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, id))
  return { name: user?.name ?? null }
}

function workspaceHooks(artifact: Artifact) {
  const w = schema.webhooks
  return artifact.organizationId ? eq(w.organizationId, artifact.organizationId) : and(isNull(w.organizationId), eq(w.userId, artifact.ownerId))
}

// Queues the event for every enabled webhook of the page's workspace that wants it. Never throws:
// a webhook that can't be queued must not fail the publish, comment or view that caused it.
export async function emitWebhookEvent(input: Input): Promise<void> {
  try {
    const w = schema.webhooks
    let hooks = await db
      .select({ id: w.id })
      .from(w)
      .where(and(workspaceHooks(input.artifact), eq(w.enabled, true), sql`${w.events} @> ${JSON.stringify([input.event])}::jsonb`))
    if (!hooks.length) return
    // At most once per page and webhook in the limit's window, so a busy page can't flood a channel
    if (input.event === 'page.opened') {
      const allowed = await Promise.all(hooks.map(async (h) => (await hit('webhook-page-opened', `${h.id}:${input.artifact.id}`)) === null))
      hooks = hooks.filter((_, i) => allowed[i])
      if (!hooks.length) return
    }
    const payload: Payload = {
      event: input.event,
      occurredAt: new Date().toISOString(),
      workspace: await workspaceOf(input.artifact),
      page: pageOf(input.artifact),
      version: input.version,
      actor: await actorOf(input.actorId),
      ...(input.comment ? { comment: { id: input.comment.id, excerpt: excerpt(input.comment.body) } } : {}),
    }
    const rows = await db
      .insert(schema.webhookDeliveries)
      .values(hooks.map((h) => ({ webhookId: h.id, event: input.event, payload })))
      .returning({ id: schema.webhookDeliveries.id })
    const ids = rows.map((r) => r.id)
    if (queued) {
      nudge?.()
      return
    }
    const sending = runWebhookQueue({ ids }).catch((err) => log.error('Sending webhooks failed', { err }))
    const waitUntil = vercelWaitUntil()
    if (waitUntil) waitUntil(sending)
    else await sending
  } catch (err) {
    log.error('Queueing a webhook failed', { err, event: input.event })
  }
}

// Vercel's per-request context (what @vercel/functions' waitUntil reads): work handed to it may
// finish after the response is sent. Absent everywhere else.
function vercelWaitUntil(): ((p: Promise<unknown>) => void) | null {
  const holder = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for('@vercel/request-context')
  ]
  const waitUntil = holder?.get?.()?.waitUntil
  return typeof waitUntil === 'function' ? waitUntil : null
}

let queued = false
let nudge: (() => void) | null = null
let timer: NodeJS.Timeout | undefined
let running: Promise<number> | null = null

// Every process of the long-running server: requests only queue deliveries
export function useWebhookQueue(on = true) {
  queued = on
}

// The one process that sends (the background worker): due deliveries every `every` ms, and at once
// when this process queues one. `every: 0` starts no timer.
export function startWebhookQueue({ every = POLL_MS }: { every?: number } = {}) {
  queued = true
  const tick = () => {
    if (!running) running = runWebhookQueue().finally(() => (running = null))
  }
  nudge = tick
  clearInterval(timer)
  timer = every ? setInterval(() => tick(), every).unref() : undefined
}

// Waits for a send in progress, for a graceful stop
export async function stopWebhookQueue() {
  clearInterval(timer)
  timer = undefined
  nudge = null
  await running?.catch(() => {})
}

type Claimed = WebhookDelivery

// Takes due deliveries so no other process sends them at the same time: the attempt is counted and
// the row is pushed LEASE_MS ahead until the result is written. Named ones are taken if nobody has
// tried them yet, whatever the clocks of this process and the database say.
async function claim(at: SQL, ids?: string[]): Promise<Claimed[]> {
  const d = schema.webhookDeliveries
  const which = ids
    ? sql`id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) and attempts = 0`
    : sql`next_attempt_at <= ${at}`
  const rows = await db.execute<{ id: string }>(sql`
    update ${d} set attempts = attempts + 1, next_attempt_at = ${at} + make_interval(secs => ${LEASE_MS / 1000}), last_attempt_at = ${at}
    where id in (
      select id from ${d} where status = 'pending' and ${which}
      order by next_attempt_at limit ${BATCH} for update skip locked)
    returning id`)
  if (!rows.length) return []
  return db
    .select()
    .from(d)
    .where(
      inArray(
        d.id,
        rows.map((r) => r.id),
      ),
    )
}

// Sends what is due (or the deliveries named, when due) and returns how many were attempted. `now`
// is for tests that move the clock.
export async function runWebhookQueue({ now, ids }: { now?: Date; ids?: string[] } = {}): Promise<number> {
  // The database's clock unless a test moves it, so every process agrees on what is due
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`
  let total = 0
  // Bounded, so one call fits in a serverless function's time; what is left waits for the next
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await claim(at, ids)
    if (!batch.length) return total
    const hooks = await db
      .select()
      .from(schema.webhooks)
      .where(inArray(schema.webhooks.id, [...new Set(batch.map((b) => b.webhookId))]))
    const byId = new Map(hooks.map((h) => [h.id, h]))
    await Promise.all(batch.map((row) => attempt(row, byId.get(row.webhookId), at)))
    total += batch.length
    if (ids || batch.length < BATCH) return total
  }
  return total
}

async function attempt(row: Claimed, hook: Webhook | undefined, at: SQL, retry = row.event !== TEST_EVENT) {
  const d = schema.webhookDeliveries
  let status: number | null = null
  let error: string | null = null
  if (!hook) return
  if (!hook.enabled) error = 'The webhook is turned off.'
  else {
    try {
      const body = render(hook.format, row.payload as Payload)
      const timestamp = Math.floor(Date.now() / 1000)
      status = await post(new URL(hook.url), body, {
        'content-type': 'application/json',
        'user-agent': 'TheArtifact-Webhooks/1.0',
        'x-artifact-event': row.event,
        'x-artifact-delivery': row.id,
        'x-artifact-signature': signature(await openWebhookSecret(hook.secret), timestamp, body),
      })
      if (status >= 300 && status < 400) error = `The address answered ${status}, a redirect. Webhooks don’t follow redirects; use the final address.`
      else if (status < 200 || status >= 300) error = `The address answered ${status}.`
    } catch (err) {
      error = err instanceof WebhookError ? err.message : 'The request failed.'
      if (!(err instanceof WebhookError)) log.warn('Webhook request failed', { err, webhookId: hook.id })
    }
  }
  const done = error === null
  const giveUp = !done && (!retry || !hook.enabled || row.attempts >= MAX_ATTEMPTS)
  await db
    .update(d)
    .set({
      status: done ? 'delivered' : giveUp ? 'failed' : 'pending',
      responseStatus: status,
      lastError: error,
      ...(done || giveUp
        ? {}
        : { nextAttemptAt: sql`${at} + make_interval(secs => ${RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length) - 1] / 1000})` }),
    })
    .where(eq(d.id, row.id))
}

const ERRORS: Record<string, string> = {
  ECONNREFUSED: 'The connection was refused.',
  ECONNRESET: 'The connection was closed before an answer.',
  EHOSTUNREACH: 'The address can’t be reached.',
  ENETUNREACH: 'The address can’t be reached.',
  CERT_HAS_EXPIRED: 'The address’s certificate has expired.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The address’s certificate is self-signed.',
  SELF_SIGNED_CERT_IN_CHAIN: 'The address’s certificate is self-signed.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'The address’s certificate is for another name.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The address’s certificate can’t be verified.',
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new WebhookError(`No answer within ${ms / 1000} seconds.`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

// Resolves the name and refuses it when any address it has is private, then connects to the address
// that was checked (so the name can't be re-resolved to something else in between), with TLS checked
// for the name. Answers the HTTP status; the body is thrown away and redirects are not followed.
async function post(url: URL, body: string, headers: Record<string, string>): Promise<number> {
  const started = Date.now()
  const local = url.protocol === 'http:'
  if (local ? !(config.allowLocalHttp && LOCAL_HOSTS.has(url.hostname)) : url.protocol !== 'https:') throw new WebhookError('Only https addresses are allowed.')
  if (url.username || url.password) throw new WebhookError('The address has a user name or password in it.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let target: Resolved
  if (local) target = host === 'localhost' ? { address: '127.0.0.1', family: 4 } : { address: host, family: isIP(host) }
  else {
    let addresses: Resolved[]
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
    else {
      try {
        addresses = await withTimeout(config.lookup(host), TIMEOUT_MS)
      } catch (err) {
        if (err instanceof WebhookError) throw err
        throw new WebhookError(`${host} could not be found.`)
      }
    }
    if (!addresses.length) throw new WebhookError(`${host} could not be found.`)
    if (addresses.some((a) => !isPublicAddress(a.address)))
      throw new WebhookError(`${host} is on a private network or a reserved address, which webhooks can’t reach.`)
    target = addresses[0]
  }
  const timeout = Math.max(1, TIMEOUT_MS - (Date.now() - started))

  return new Promise((resolve, reject) => {
    const options = {
      host: target.address,
      family: target.family,
      port: url.port || (local ? 80 : 443),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, host: url.host, 'content-length': String(Buffer.byteLength(body)) },
      agent: false as const,
      ...(local || isIP(host) ? {} : { servername: host }),
    }
    const onResponse = (res: IncomingMessage) => {
      clearTimeout(timer)
      // Only the status matters; nothing of the answer is read or kept
      res.destroy()
      resolve(res.statusCode ?? 0)
    }
    const req = local ? httpRequest(options, onResponse) : httpsRequest(options, onResponse)
    const timer = setTimeout(() => req.destroy(new WebhookError(`No answer within ${TIMEOUT_MS / 1000} seconds.`)), timeout)
    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(err instanceof WebhookError ? err : new WebhookError(ERRORS[err.code ?? ''] ?? `The request failed (${err.code ?? 'error'}).`))
    })
    req.end(body)
  })
}

// "Send a test": one delivery of TEST_EVENT, sent now whatever the mode and never retried
export async function sendTestDelivery(hook: Webhook, workspace: Payload['workspace']): Promise<WebhookDelivery> {
  const payload: Payload = { event: TEST_EVENT, occurredAt: new Date().toISOString(), workspace }
  const [row] = await db.insert(schema.webhookDeliveries).values({ webhookId: hook.id, event: TEST_EVENT, payload }).returning()
  const [claimed] = await claim(sql`now()`, [row.id])
  if (claimed) await attempt(claimed, hook, sql`now()`, false)
  const [done] = await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, row.id))
  return done
}

// Deliveries still waiting when a webhook is turned off are dropped, so turning it back on doesn't
// send a backlog of old events
export async function dropPending(webhookId: string) {
  const d = schema.webhookDeliveries
  await db
    .update(d)
    .set({ status: 'failed', lastError: 'The webhook was turned off.' })
    .where(and(eq(d.webhookId, webhookId), eq(d.status, 'pending')))
}

export async function recentDeliveries(webhookId: string, limit = 50) {
  const d = schema.webhookDeliveries
  return db
    .select({
      id: d.id,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      lastError: d.lastError,
      nextAttemptAt: d.nextAttemptAt,
      lastAttemptAt: d.lastAttemptAt,
      createdAt: d.createdAt,
    })
    .from(d)
    .where(eq(d.webhookId, webhookId))
    .orderBy(desc(d.createdAt))
    .limit(limit)
}

// Run before each storage sweep (src/gc.ts) and by /api/cron/sweep
export async function pruneWebhookDeliveries(now = new Date()): Promise<number> {
  const rows = await db.execute(
    sql`delete from webhook_deliveries where created_at < ${now.toISOString()}::timestamptz - make_interval(days => ${DELIVERY_RETENTION_DAYS}) returning 1`,
  )
  return rows.length
}
