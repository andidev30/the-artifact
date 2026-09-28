import { randomInt } from 'node:crypto'
import { and, count, eq, isNotNull, lt } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env, isProduction } from '../env.js'
import { atLimit, clearHits, clientIp, hit, limitRequest, tooManyRequests, waitText } from '../limits.js'
import { log } from '../log.js'
import { hasSecondFactor, organizationsRequiringFactor } from './factors.js'
import { authenticationOptions, PasskeyError, verifyAuthentication } from './passkeys.js'
import { hashToken, randomToken, startSession } from './session.js'
import { matchTotp, openSecret } from './totp.js'
import { afterSignInUrl, safeNext } from './users.js'

// Two-factor sign-in. Every first factor (a password, an email link, an admin's link, Google) ends in
// continueSignIn: an account with a passkey or an authenticator app gets a pending sign-in instead of
// a session, and the session starts only once the second factor is checked at /login/two-factor.
// Signing in with a passkey alone skips this: the passkey is something you have, unlocked with
// something you are or know (user verification is required for it).

const PENDING_COOKIE = 'sign_in_pending'
const PENDING_TTL = 10 * 60 * 1000
const PENDING_PATH = '/api/auth'

export const RECOVERY_CODE_COUNT = 10
// No 0/o, 1/i/l: codes are read off paper
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const RECOVERY_LENGTH = 10

// After the first factor: a session, or a pending sign-in when the account has a second factor.
// Returns where the browser goes next.
export async function continueSignIn(c: Context, user: Pick<User, 'id'>, redirect: string): Promise<string> {
  if (await hasSecondFactor(user.id)) {
    const token = randomToken()
    await db.delete(schema.pendingSignIns).where(lt(schema.pendingSignIns.expiresAt, new Date()))
    await db.insert(schema.pendingSignIns).values({ id: hashToken(token), userId: user.id, redirect, expiresAt: new Date(Date.now() + PENDING_TTL) })
    setCookie(c, PENDING_COOKIE, token, { path: PENDING_PATH, httpOnly: true, secure: isProduction, sameSite: 'Lax', maxAge: PENDING_TTL / 1000 })
    return new URL('/login/two-factor', env.appUrl).toString()
  }
  await startSession(c, user.id)
  return await setUpFirst(user.id, redirect)
}

// Someone in an organization that requires a second factor, who has none yet, is taken to set one up
// unless they were on their way somewhere in particular (an agent's connection request, a page)
async function setUpFirst(userId: string, redirect: string): Promise<string> {
  if (new URL(redirect).pathname !== '/app') return redirect
  if (!(await organizationsRequiringFactor(userId)).length) return redirect
  return new URL('/settings?two-factor=required#security', env.appUrl).toString()
}

async function pendingFrom(c: Context) {
  const token = getCookie(c, PENDING_COOKIE)
  if (!token) return null
  const [row] = await db
    .select({ pending: schema.pendingSignIns, user: schema.users })
    .from(schema.pendingSignIns)
    .innerJoin(schema.users, eq(schema.pendingSignIns.userId, schema.users.id))
    .where(eq(schema.pendingSignIns.id, hashToken(token)))
  if (!row || row.pending.expiresAt.getTime() < Date.now() || row.user.suspendedAt) return null
  return row
}

export function clearPending(c: Context) {
  deleteCookie(c, PENDING_COOKIE, { path: PENDING_PATH })
}

// The second factor checked out: the pending sign-in becomes a session, once
async function finish(c: Context, pendingId: string, userId: string) {
  const [used] = await db.delete(schema.pendingSignIns).where(eq(schema.pendingSignIns.id, pendingId)).returning()
  clearPending(c)
  if (!used) return null
  await startSession(c, userId)
  return used.redirect
}

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from({ length: RECOVERY_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
    return `${chars.slice(0, 5)}-${chars.slice(5)}`
  })
}

const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '')

// Replaces every recovery code of the account; the new ones are shown once and stored hashed
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = newRecoveryCodes()
  await db.transaction(async (tx) => {
    await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
    await tx.insert(schema.recoveryCodes).values(codes.map((code) => ({ userId, codeHash: hashToken(normalizeRecoveryCode(code)) })))
  })
  return codes
}

export async function recoveryCodesLeft(userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
  return row.n
}

// Deleting the row is what makes a code single-use, so two requests can't both spend it
async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code)
  if (normalized.length !== RECOVERY_LENGTH) return false
  const used = await db
    .delete(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), eq(schema.recoveryCodes.codeHash, hashToken(normalized))))
    .returning({ id: schema.recoveryCodes.id })
  return used.length > 0
}

// A code from the authenticator app. Moving last_step forward in the same statement that checks it
// means a code, or any older one, is accepted once even when two requests race.
export async function useTotpCode(userId: string, code: string, opts: { confirmed: boolean } = { confirmed: true }): Promise<boolean> {
  const [row] = await db
    .select()
    .from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, userId), opts.confirmed ? isNotNull(schema.totpSecrets.confirmedAt) : undefined))
  if (!row) return false
  const step = matchTotp(await openSecret(row.secret), code, row.lastStep)
  if (step === null) return false
  const moved = await db
    .update(schema.totpSecrets)
    .set({ lastStep: step, ...(opts.confirmed ? {} : { confirmedAt: new Date() }) })
    .where(and(eq(schema.totpSecrets.userId, userId), lt(schema.totpSecrets.lastStep, step)))
    .returning({ userId: schema.totpSecrets.userId })
  return moved.length > 0
}

const TOO_MANY_TRIES = 'Too many sign-in attempts from your network.'
const EXPIRED = { error: 'Your sign-in has expired. Sign in again.', code: 'sign_in_expired' }

// Wrong codes for one account count against the two-factor limit; a right one clears it
export async function codeLimited(c: Context, userId: string) {
  const locked = await atLimit('two-factor', userId)
  if (!locked) return null
  return tooManyRequests(c, `Too many wrong codes. Try again in ${waitText(locked)}, or use a passkey.`, locked, { code: 'too_many_attempts' })
}

// Mounted at /api/auth/two-factor: the second step of signing in
export const twoFactor = new Hono()

twoFactor.get('/', async (c) => {
  const row = await pendingFrom(c)
  if (!row) return c.json(EXPIRED, 404)
  const userId = row.user.id
  const [passkey] = await db.select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).limit(1)
  const [totp] = await db
    .select({ userId: schema.totpSecrets.userId })
    .from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, userId), isNotNull(schema.totpSecrets.confirmedAt)))
  return c.json({
    email: row.user.email,
    passkey: Boolean(passkey),
    totp: Boolean(totp),
    recoveryCodes: (await recoveryCodesLeft(userId)) > 0,
  })
})

// { code }: six digits from the authenticator app, or a recovery code
twoFactor.post('/code', async (c) => {
  const busy = await limitRequest(c, 'two-factor-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const row = await pendingFrom(c)
  if (!row) return c.json(EXPIRED, 401)
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!code) return c.json({ error: 'Enter the code.', field: 'code' }, 400)
  const limited = await codeLimited(c, row.user.id)
  if (limited) return limited

  const digits = /^\d{6}$/.test(code.replace(/\s/g, ''))
  const ok = digits ? await useTotpCode(row.user.id, code) : await useRecoveryCode(row.user.id, code)
  if (!ok) {
    await hit('two-factor', row.user.id)
    return c.json(
      { error: digits ? 'That code is wrong or was already used. Wait for the next one.' : 'That recovery code is wrong or was already used.', field: 'code' },
      400,
    )
  }
  await clearHits('two-factor', row.user.id)
  if (!digits) log.info('Signed in with a recovery code', { userId: row.user.id })
  const redirect = await finish(c, row.pending.id, row.user.id)
  if (!redirect) return c.json(EXPIRED, 401)
  return c.json({ redirect })
})

twoFactor.post('/passkey/options', async (c) => {
  const busy = await limitRequest(c, 'two-factor-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const row = await pendingFrom(c)
  if (!row) return c.json(EXPIRED, 401)
  return c.json(await authenticationOptions('second-factor', row.user.id))
})

// { response }: what navigator.credentials.get() returned, as JSON
twoFactor.post('/passkey', async (c) => {
  const busy = await limitRequest(c, 'two-factor-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const row = await pendingFrom(c)
  if (!row) return c.json(EXPIRED, 401)
  const body = (await c.req.json().catch(() => null)) as { response?: AuthenticationResponseJSON } | null
  try {
    await verifyAuthentication('second-factor', row.user.id, body?.response as AuthenticationResponseJSON)
  } catch (err) {
    if (err instanceof PasskeyError) return c.json({ error: err.message }, 400)
    throw err
  }
  const redirect = await finish(c, row.pending.id, row.user.id)
  if (!redirect) return c.json(EXPIRED, 401)
  return c.json({ redirect })
})

// Mounted at /api/auth/passkey: signing in with a passkey alone, without an email address
export const passkeySignIn = new Hono()

passkeySignIn.post('/options', async (c) => {
  const busy = await limitRequest(c, 'two-factor-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  return c.json(await authenticationOptions('sign-in', null))
})

// { response, plan?, next? }
passkeySignIn.post('/', async (c) => {
  const busy = await limitRequest(c, 'two-factor-ip', clientIp(c), TOO_MANY_TRIES)
  if (busy) return busy
  const body = (await c.req.json().catch(() => null)) as { response?: AuthenticationResponseJSON; plan?: unknown; next?: unknown } | null
  let passkey: Awaited<ReturnType<typeof verifyAuthentication>>
  try {
    passkey = await verifyAuthentication('sign-in', null, body?.response as AuthenticationResponseJSON)
  } catch (err) {
    if (err instanceof PasskeyError) return c.json({ error: err.message }, 400)
    throw err
  }
  const [user] = await db.select({ suspendedAt: schema.users.suspendedAt }).from(schema.users).where(eq(schema.users.id, passkey.userId))
  if (user?.suspendedAt) {
    return c.json({ error: 'This account is suspended. Ask an admin of this server to restore it.', code: 'account_suspended' }, 403)
  }
  await startSession(c, passkey.userId)
  const plan = typeof body?.plan === 'string' ? body.plan : null
  return c.json({ redirect: afterSignInUrl(plan, safeNext(typeof body?.next === 'string' ? body.next : null)) })
})

// Removes every second factor and recovery code of the account and signs it out everywhere. For an
// instance admin helping someone who lost their phone and their codes.
export async function resetSecondFactor(userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(schema.passkeys).where(eq(schema.passkeys.userId, userId))
    await tx.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, userId))
    await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
    await tx.delete(schema.webauthnChallenges).where(eq(schema.webauthnChallenges.userId, userId))
    await tx.delete(schema.pendingSignIns).where(eq(schema.pendingSignIns.userId, userId))
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
  })
}

// Once the last passkey or the authenticator app goes, recovery codes have nothing left to stand in for
export async function dropCodesWithoutFactor(userId: string) {
  if (!(await hasSecondFactor(userId))) await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
}
