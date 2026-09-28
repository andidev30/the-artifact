import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { accessLevel, artifactUrl, keyMatches, linkOpen, type Access, type LinkPass } from './artifacts.js'
import { hashPassword, passwordProblem } from './auth/password.js'
import type { AuthEnv } from './auth/session.js'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import { env, isProduction } from './env.js'
import { serverSecret } from './secrets.js'

// Link sharing can end on a date, need a password, and be reset. None of it touches the page's own
// address (/a/<slug>), which the owner, invited people and organization members keep using.
//
// Resetting gives the link a key: the public link becomes /a/<slug>?k=<key>, and a visitor without
// access of their own needs the current key, so every earlier public link answers like a missing
// page. A page whose link was never reset has no key and its plain address stays the public link,
// so links shared before keys existed keep working until their first reset.
//
// A visitor who passed the key and the password gets a grant: an HMAC over the page, its key, its
// password hash and an expiry, so a reset or a new password makes every earlier one useless. It is
// kept in a cookie scoped to /api/artifacts/<slug>, which the app's API requests carry after the first
// one, and the sandboxed frame's navigation is redirected to /v/<n>/~<grant>/ like a signed-in
// viewer's link token (see content.ts), because the frame's subresource requests carry no cookies.

export class LinkError extends Error {
  constructor(
    message: string,
    readonly field: 'expiresAt' | 'password',
  ) {
    super(message)
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// A date (YYYY-MM-DD, meaning the end of that day in UTC) or a date and time with a time zone.
// null, '' or 'never' for no expiry.
export function parseLinkExpiry(value: unknown, now = new Date()): Date | null {
  if (value === null || value === '' || value === 'never') return null
  if (typeof value !== 'string') throw new LinkError('Give the expiry as a date like 2026-12-31, or a date and time.', 'expiresAt')
  const trimmed = value.trim()
  const at = DATE_RE.test(trimmed) ? new Date(`${trimmed}T23:59:59.999Z`) : new Date(trimmed)
  if (Number.isNaN(at.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(trimmed))
    throw new LinkError('Give the expiry as a date like 2026-12-31, or a date and time.', 'expiresAt')
  if (at <= now) throw new LinkError('Choose an expiry in the future.', 'expiresAt')
  if (at.getUTCFullYear() > 9999) throw new LinkError('Choose an earlier expiry date.', 'expiresAt')
  return at
}

// null or '' removes the password
export function checkLinkPassword(value: unknown): string | null {
  if (value === null || value === '') return null
  const problem = passwordProblem(value)
  if (problem) throw new LinkError(problem, 'password')
  return value as string
}

export type LinkChange = { expiresAt?: Date | null; password?: string | null; reset?: boolean }

export async function updateLink(artifact: Artifact, change: LinkChange): Promise<Artifact> {
  const set: Partial<typeof schema.artifacts.$inferInsert> = {}
  if (change.expiresAt !== undefined) set.linkExpiresAt = change.expiresAt
  if (change.password !== undefined) set.linkPasswordHash = change.password === null ? null : await hashPassword(change.password)
  if (change.reset) set.linkToken = randomBytes(16).toString('base64url')
  if (Object.keys(set).length === 0) return artifact
  const [updated] = await db.update(schema.artifacts).set(set).where(eq(schema.artifacts.id, artifact.id)).returning()
  return updated
}

export const keyQuery = (artifact: Artifact) => (artifact.linkToken ? `?k=${artifact.linkToken}` : '')

// The address to hand to people without access of their own
export function publicLink(artifact: Artifact): string {
  return `${artifactUrl(artifact.slug)}${keyQuery(artifact)}`
}

export function embedLink(artifact: Artifact): string {
  return `${env.appUrl}/e/${artifact.slug}${keyQuery(artifact)}`
}

// What the share dialog and agents are told about the link. Editors only: it holds the key.
export function linkSettings(artifact: Artifact) {
  return {
    expiresAt: artifact.linkExpiresAt?.toISOString() ?? null,
    password: artifact.linkPasswordHash !== null,
    expired: isExpired(artifact),
    url: publicLink(artifact),
    embedUrl: embedLink(artifact),
  }
}

export function isExpired(artifact: Artifact, now = new Date()): boolean {
  return artifact.linkExpiresAt !== null && artifact.linkExpiresAt <= now
}

// A link anyone with it could open, but only with the password
export function needsPassword(artifact: Artifact): boolean {
  return linkOpen(artifact) && artifact.linkPasswordHash !== null
}

// Whether passing the link is worth remembering: plain links let everyone in anyway
const keeps = (artifact: Artifact) => artifact.linkToken !== null || artifact.linkPasswordHash !== null

const GRANT_HOURS = 12
const COOKIE = 'page_link'
const GRANT_RE = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{32})$/

const secret = () => serverSecret('content-links')

function mac(key: Buffer, artifact: Artifact, exp: number) {
  return createHmac('sha256', key).update(`link|${artifact.id}|${artifact.linkToken}|${artifact.linkPasswordHash}|${exp}`).digest('base64url').slice(0, 32)
}

// Stable for an hour at a time, like content link tokens, so the browser cache keeps working
export async function signGrant(artifact: Artifact, now = Date.now()): Promise<{ token: string; expires: Date }> {
  const hour = 3600_000
  const expires = Math.floor(now / hour) * hour + (GRANT_HOURS + 1) * hour
  const exp = Math.floor(expires / 1000)
  return { token: `${exp.toString(36)}.${mac(await secret(), artifact, exp)}`, expires: new Date(expires) }
}

// Signed-in viewers' link tokens have three parts (content.ts); grants have two
export function isGrant(token: string): boolean {
  return GRANT_RE.test(token)
}

export async function verifyGrant(token: string, artifact: Artifact, now = Date.now()): Promise<boolean> {
  const match = token.match(GRANT_RE)
  if (!match || !linkOpen(artifact) || !keeps(artifact)) return false
  const exp = parseInt(match[1], 36)
  if (exp * 1000 < now) return false
  const expected = Buffer.from(mac(await secret(), artifact, exp))
  const given = Buffer.from(match[2])
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export async function setGrantCookie(c: Context, artifact: Artifact) {
  const { token, expires } = await signGrant(artifact)
  setCookie(c, COOKIE, token, { path: `/api/artifacts/${artifact.slug}`, httpOnly: true, secure: isProduction, sameSite: 'Lax', expires })
}

// The link's key in ?k=, and a grant from the cookie
export async function linkPassFor(c: Context, artifact: Artifact): Promise<LinkPass> {
  const cookie = keeps(artifact) ? getCookie(c, COOKIE) : undefined
  return { key: c.req.query('k') ?? null, granted: cookie ? await verifyGrant(cookie, artifact) : false }
}

// The key alone lets the request in when there is no password; worth a cookie when there is a key
export function keyLetsIn(artifact: Artifact, key: string | null | undefined): boolean {
  return keeps(artifact) && linkOpen(artifact) && artifact.linkPasswordHash === null && keyMatches(artifact, key)
}

// The request's access to a page: its session, plus the link's key and password
export async function accessFor(c: Context<AuthEnv>, artifact: Artifact): Promise<Access> {
  return accessLevel(artifact, c.get('user'), await linkPassFor(c, artifact))
}

const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

// " (until 2026-12-31 23:59 UTC, with a password)", for agents; empty unless shared by link
export function describeLink(artifact: Artifact): string {
  if (artifact.visibility !== 'link') return ''
  const parts: string[] = []
  if (artifact.linkExpiresAt) parts.push(isExpired(artifact) ? `the link expired ${utc(artifact.linkExpiresAt)}` : `until ${utc(artifact.linkExpiresAt)}`)
  if (artifact.linkPasswordHash) parts.push('with a password')
  return parts.length ? ` (${parts.join(', ')})` : ''
}
