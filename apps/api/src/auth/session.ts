import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { isProduction } from '../env.js'

const COOKIE = 'session'
const DAY = 24 * 60 * 60 * 1000
const SESSION_TTL = 30 * DAY
// Extend a session once less than half its lifetime is left
const RENEW_BEFORE = 15 * DAY
// How stale users.last_seen_at may get before a request refreshes it
const SEEN_EVERY = 5 * 60 * 1000

export type AuthEnv = { Variables: { user: User | null } }

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function startSession(c: Context, userId: string) {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL)
  await db.insert(schema.sessions).values({ id: hashToken(token), userId, expiresAt })
  setSessionCookie(c, token, expiresAt)
}

export async function endSession(c: Context) {
  const token = getCookie(c, COOKIE)
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)))
  deleteCookie(c, COOKIE, { path: '/' })
}

function setSessionCookie(c: Context, token: string, expiresAt: Date) {
  setCookie(c, COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Lax',
    expires: expiresAt,
  })
}

// Puts the signed-in user (or null) on c.var.user for every request
export const loadUser = createMiddleware<AuthEnv>(async (c, next) => {
  c.set('user', null)
  const token = getCookie(c, COOKIE)
  if (token) {
    const id = hashToken(token)
    const [row] = await db
      .select({ session: schema.sessions, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(eq(schema.sessions.id, id))

    // Suspended people are signed out everywhere (their sessions are deleted too)
    if (!row || row.session.expiresAt.getTime() < Date.now() || row.user.suspendedAt) {
      if (row) await db.delete(schema.sessions).where(eq(schema.sessions.id, id))
      deleteCookie(c, COOKIE, { path: '/' })
    } else {
      if (row.session.expiresAt.getTime() - Date.now() < RENEW_BEFORE) {
        const expiresAt = new Date(Date.now() + SESSION_TTL)
        await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, id))
        setSessionCookie(c, token, expiresAt)
      }
      if (!row.user.lastSeenAt || Date.now() - row.user.lastSeenAt.getTime() > SEEN_EVERY) {
        row.user.lastSeenAt = new Date()
        await db.update(schema.users).set({ lastSeenAt: row.user.lastSeenAt }).where(eq(schema.users.id, row.user.id))
      }
      c.set('user', row.user)
    }
  }
  await next()
})

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Sign in to continue.' }, 401)
  await next()
})
