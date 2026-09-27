import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import { mailEnabled } from '../env.js'
import { firstAccountBecomesAdmin, hasAccounts, lockAdmins } from '../instance.js'
import { startSession } from './session.js'
import { afterSignInUrl } from './users.js'

// Passwords are for servers that can't send sign-in links by email. On those, people sign in with
// a password (or Google); the first account is created from the setup form and later ones from a
// link an admin passes on, or from an organization invitation link.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_LENGTH = 8
const MAX_LENGTH = 200
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 32

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

// Stored as scrypt$N$r$p$salt$hash so the cost can be raised later without breaking old hashes
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = (stored ?? '').split('$')
  if (kind !== 'scrypt' || !salt || !hash) {
    // Same work either way, so a missing account doesn't answer faster than a wrong password
    await derive(password, randomBytes(16))
    return false
  }
  const expected = Buffer.from(hash, 'base64url')
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (err, k) =>
      err ? reject(err) : resolve(k),
    ),
  )
  return timingSafeEqual(key, expected)
}

// null when the password is fine, otherwise what to tell the person
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters for the password.`
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters for the password.`
  return null
}

// Failed logins per address, kept in memory: enough to slow down guessing, reset on restart
const FAIL_WINDOW = 15 * 60 * 1000
const MAX_FAILS = 10
const failures = new Map<string, { count: number; since: number }>()

function lockedOut(email: string): boolean {
  const f = failures.get(email)
  if (!f) return false
  if (Date.now() - f.since > FAIL_WINDOW) {
    failures.delete(email)
    return false
  }
  return f.count >= MAX_FAILS
}

function recordFailure(email: string) {
  const f = failures.get(email)
  if (!f || Date.now() - f.since > FAIL_WINDOW) failures.set(email, { count: 1, since: Date.now() })
  else f.count++
}

export const password = new Hono()

type Body = { email?: unknown; password?: unknown; name?: unknown; plan?: unknown; next?: unknown }

password.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Body | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const given = typeof body?.password === 'string' ? body.password : ''
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  if (!given) return c.json({ error: 'Enter your password.', field: 'password' }, 400)
  if (lockedOut(email)) {
    return c.json({ error: 'Too many wrong passwords for this address. Wait 15 minutes, or ask an admin for a new sign-in link.', code: 'too_many_attempts' }, 429)
  }

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (!(await verifyPassword(given, user?.passwordHash ?? null)) || !user) {
    recordFailure(email)
    const hint = user && !user.passwordHash ? ' This account has no password yet; use Google, or ask an admin for a sign-in link.' : ''
    return c.json({ error: `The email or password is wrong.${hint}`, code: 'wrong_password' }, 401)
  }
  if (user.suspendedAt) {
    return c.json({ error: 'This account is suspended. Ask an admin of this server to restore it.', code: 'account_suspended' }, 403)
  }
  failures.delete(email)
  await startSession(c, user.id)
  return c.json({ redirect: afterSignInUrl(typeof body?.plan === 'string' ? body.plan : null, typeof body?.next === 'string' ? body.next : null) })
})

// The first account on a server without email. It becomes the instance admin on a self-hosted install.
password.post('/setup', async (c) => {
  if (mailEnabled()) return c.json({ error: 'This server sends sign-in links by email. Sign up with your email instead.', code: 'email_enabled' }, 409)
  const body = (await c.req.json().catch(() => null)) as Body | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)
  const passwordHash = await hashPassword(body!.password as string)

  const created = await db.transaction(async (tx) => {
    await lockAdmins(tx)
    if (await hasAccounts(tx)) return null
    const isAdmin = await firstAccountBecomesAdmin(tx)
    const [user] = await tx.insert(schema.users).values({ email, name, passwordHash, isAdmin }).returning()
    return user
  })
  if (!created) return c.json({ error: 'This server is already set up. Log in instead.', code: 'already_set_up' }, 409)
  await startSession(c, created.id)
  return c.json({ redirect: afterSignInUrl(null, null) }, 201)
})
