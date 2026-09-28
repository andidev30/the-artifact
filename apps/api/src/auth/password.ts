import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { track } from '../analytics.js'
import { db, schema } from '../db/index.js'
import { mailEnabled } from '../env.js'
import { hasAccounts, instanceSettings, lockAdmins, newAccountFields, type EffectiveSettings } from '../instance.js'
import { clearHits, clientIp, hit, limitRequest, tooManyRequests, waitText } from '../limits.js'
import { ssoRequiredError, ssoRequiredFor } from '../ee/sso/connections.js'
import { startSession } from './session.js'
import { continueSignIn, signInFailed } from './twofactor.js'
import { ACCOUNT_EMAIL_RE, CONTROL_CHARS_ERROR, EMAIL_RE, hasControlChars } from '../validation.js'
import { afterSignInUrl, createPasswordAccount, waitingForAccess } from './users.js'

// Passwords are for servers that can't send sign-in links by email. On those, people sign in with
// a password (or Google); the first account is created from the setup form and later ones from a
// link an admin passes on, or from an organization invitation link.

const MIN_LENGTH = 8
const MAX_LENGTH = 200
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 32

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))))
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

export const password = new Hono()

type Body = { email?: unknown; password?: unknown; name?: unknown; plan?: unknown; next?: unknown }

const TOO_MANY_TRIES = 'Too many sign-in attempts from your network.'

password.post('/login', async (c) => {
  const busy = await limitRequest(c, 'password-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const body = (await c.req.json().catch(() => null)) as Body | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const given = typeof body?.password === 'string' ? body.password : ''
  // Only finds an existing account, so addresses from before EMAIL_RE was tightened still sign in
  if (!ACCOUNT_EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  if (!given) return c.json({ error: 'Enter your password.', field: 'password' }, 400)
  // Counted before the check, so attempts sent at once can't all be checked; a right password clears
  // the count, so someone who knows theirs isn't locked out by their own sign-ins
  const locked = await hit('password', email)
  if (locked) {
    return tooManyRequests(c, `Too many wrong passwords for this address. Try again in ${waitText(locked)}, or ask an admin for a new sign-in link.`, locked, {
      code: 'too_many_attempts',
    })
  }

  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (!(await verifyPassword(given, user?.passwordHash ?? null)) || !user) {
    if (user) signInFailed(user, 'wrong password')
    const hint = user && !user.passwordHash ? ' This account has no password yet; use Google, or ask an admin for a sign-in link.' : ''
    return c.json({ error: `The email or password is wrong.${hint}`, code: 'wrong_password' }, 401)
  }
  if (user.suspendedAt) {
    signInFailed(user, 'account suspended')
    return c.json({ error: 'This account is suspended. Ask an admin of this server to restore it.', code: 'account_suspended' }, 403)
  }
  await clearHits('password', email)
  const redirect = afterSignInUrl(typeof body?.plan === 'string' ? body.plan : null, typeof body?.next === 'string' ? body.next : null)
  return c.json({ redirect: await continueSignIn(c, user, redirect, 'password') })
})

// The first account on a server without email. It becomes the instance admin on a self-hosted install.
password.post('/setup', async (c) => {
  if (mailEnabled()) return c.json({ error: 'This server sends sign-in links by email. Sign up with your email instead.', code: 'email_enabled' }, 409)
  const busy = await limitRequest(c, 'password-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const body = (await c.req.json().catch(() => null)) as Body | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  if (name && hasControlChars(name)) return c.json({ error: CONTROL_CHARS_ERROR, field: 'name' }, 400)
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)
  const passwordHash = await hashPassword(body!.password as string)

  const created = await db.transaction(async (tx) => {
    await lockAdmins(tx)
    if (await hasAccounts(tx)) return null
    const [user] = await tx
      .insert(schema.users)
      .values({ email, name, passwordHash, ...(await newAccountFields(tx)) })
      .returning()
    return user
  })
  if (!created) return c.json({ error: 'This server is already set up. Log in instead.', code: 'already_set_up' }, 409)
  track({ event: 'signed_up', userId: created.id, detail: 'password' })
  await startSession(c, created.id)
  return c.json({ redirect: afterSignInUrl(null, null) }, 201)
})

// Whether people may create a password account on their own: a server without email whose sign-up
// policy lets people in. The address isn't verified, which is why invitations need their link.
export function passwordSignUpOpen(settings: Pick<EffectiveSettings, 'signupPolicy'>): boolean {
  if (mailEnabled()) return false
  return settings.signupPolicy !== 'invite-only'
}

// Signing up with a password on a server without email, under the Anyone or Email domains policy.
// Nobody checks that the address belongs to the person typing it, so an address someone invited
// or shared a page with can't be claimed here: that person uses their invitation link or an
// admin's sign-up link, or the first to type the address would get what was meant for them.
password.post('/sign-up', async (c) => {
  if (mailEnabled()) return c.json({ error: 'This server sends sign-in links by email. Sign up with your email instead.', code: 'email_enabled' }, 409)
  const busy = await limitRequest(c, 'password-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const body = (await c.req.json().catch(() => null)) as Body | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  if (name && hasControlChars(name)) return c.json({ error: CONTROL_CHARS_ERROR, field: 'name' }, 400)

  const { signupPolicy, allowedDomains } = await instanceSettings()
  if (signupPolicy === 'invite-only') {
    return c.json({ error: 'This server only accepts invited people. Ask an admin for a sign-up link.', code: 'signup_closed' }, 403)
  }
  if (signupPolicy === 'domains' && !allowedDomains.includes(email.split('@')[1] ?? '')) {
    return c.json(
      { error: 'This server only accepts addresses at certain domains. Ask an admin for a sign-up link.', code: 'signup_closed', field: 'email' },
      403,
    )
  }
  if (await waitingForAccess(email)) {
    return c.json(
      {
        error:
          'Someone invited this address or shared a page with it. Open the invitation link you were sent, or ask an admin of this server for a sign-up link.',
        code: 'use_invitation',
        field: 'email',
      },
      409,
    )
  }
  if (await ssoRequiredFor({ email, isAdmin: false, suspendedAt: null })) return c.json({ ...ssoRequiredError, field: 'email' }, 403)
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)

  const created = await createPasswordAccount(email, name, await hashPassword(body!.password as string), true)
  if (!created) return c.json({ error: 'This address already has an account. Log in instead.', code: 'account_exists', field: 'email' }, 409)
  await startSession(c, created.id)
  return c.json({ redirect: afterSignInUrl(typeof body?.plan === 'string' ? body.plan : null, typeof body?.next === 'string' ? body.next : null) }, 201)
})
