import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { isProduction } from '../env.js'
import { blockedOrganizations } from './factors.js'

const COOKIE = 'session'
const DAY = 24 * 60 * 60 * 1000
const SESSION_TTL = 30 * DAY
// Extend a session once less than half its lifetime is left
const RENEW_BEFORE = 15 * DAY
// How stale users.last_seen_at and sessions.last_active_at may get before a request refreshes them
const SEEN_EVERY = 5 * 60 * 1000
// Changing how you sign in (passkeys, authenticator app, recovery codes) needs a session this fresh,
// so a session cookie someone else got hold of can't be turned into a factor of their own
export const RECENT_SIGN_IN = 60 * 60 * 1000
const MAX_USER_AGENT = 512

// blockedOrgs: organizations that require a second factor this person hasn't set up; the web app
// treats them as if the person weren't a member (see src/auth/factors.ts)
export type SessionUser = User & { blockedOrgs: string[] }
export type Session = typeof schema.sessions.$inferSelect
export type AuthEnv = { Variables: { user: SessionUser | null; session: Session | null } }

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// What the sessions list calls a session. Derived from the stored hash, which never leaves the server.
export function sessionRef(id: string): string {
  return createHash('sha256').update(`session:${id}`).digest('base64url').slice(0, 22)
}

// signedInAt: when the person last proved who they are, if not now (it decides RECENT_SIGN_IN)
export async function startSession(c: Context, userId: string, signedInAt?: Date) {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL)
  const userAgent = c.req.header('user-agent')?.slice(0, MAX_USER_AGENT) || null
  await db
    .insert(schema.sessions)
    .values({ id: hashToken(token), userId, expiresAt, userAgent, lastActiveAt: new Date(), ...(signedInAt ? { createdAt: signedInAt } : {}) })
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
  c.set('session', null)
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
      const now = Date.now()
      const set: Partial<Session> = {}
      if (row.session.expiresAt.getTime() - now < RENEW_BEFORE) {
        set.expiresAt = new Date(now + SESSION_TTL)
        setSessionCookie(c, token, set.expiresAt)
      }
      if (!row.session.lastActiveAt || now - row.session.lastActiveAt.getTime() > SEEN_EVERY) set.lastActiveAt = new Date(now)
      if (Object.keys(set).length) {
        Object.assign(row.session, set)
        await db.update(schema.sessions).set(set).where(eq(schema.sessions.id, id))
      }
      if (!row.user.lastSeenAt || now - row.user.lastSeenAt.getTime() > SEEN_EVERY) {
        row.user.lastSeenAt = new Date(now)
        await db.update(schema.users).set({ lastSeenAt: row.user.lastSeenAt }).where(eq(schema.users.id, row.user.id))
      }
      c.set('user', { ...row.user, blockedOrgs: await blockedOrganizations(row.user.id) })
      c.set('session', row.session)
    }
  }
  await next()
})

export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Sign in to continue.' }, 401)
  await next()
})

// For changes to how someone signs in: the session must have started within RECENT_SIGN_IN
export const requireRecentSignIn = createMiddleware<AuthEnv>(async (c, next) => {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Sign in to continue.' }, 401)
  if (Date.now() - session.createdAt.getTime() > RECENT_SIGN_IN) {
    return c.json({ error: 'For your security, sign in again to change how you sign in. It needs a sign-in from the last hour.', code: 'reauth_required' }, 403)
  }
  await next()
})
