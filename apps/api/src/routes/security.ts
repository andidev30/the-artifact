import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { describeDevice } from '../auth/devices.js'
import { hasSecondFactor, organizationsRequiringFactor } from '../auth/factors.js'
import { MAX_PASSKEYS, PasskeyError, passkeysOf, registrationOptions, verifyRegistration } from '../auth/passkeys.js'
import { hashToken, RECENT_SIGN_IN, requireRecentSignIn, requireUser, sessionRef, type AuthEnv } from '../auth/session.js'
import { base32Encode, newTotpSecret, otpauthUrl, sealSecret } from '../auth/totp.js'
import { codeLimited, dropCodesWithoutFactor, recoveryCodesLeft, replaceRecoveryCodes, useTotpCode } from '../auth/twofactor.js'
import { db, schema } from '../db/index.js'
import type { Passkey } from '../db/schema.js'
import { hit, clearHits, limitRequest } from '../limits.js'
import { log } from '../log.js'
import { instanceSettings } from '../instance.js'
import { UUID_RE } from '../validation.js'

// How you sign in, mounted at /api/me/security: passkeys, the authenticator app and recovery codes.
// Changes need a recent sign-in (requireRecentSignIn); new recovery codes are in the response only.
export const security = new Hono<AuthEnv>()
security.use(requireUser)

const MAX_PASSKEY_NAME = 60

function describePasskey(p: Passkey) {
  return { id: p.id, name: p.name, backedUp: p.backedUp, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }
}

async function totpEnabled(userId: string) {
  const [row] = await db
    .select({ userId: schema.totpSecrets.userId })
    .from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, userId), isNotNull(schema.totpSecrets.confirmedAt)))
  return Boolean(row)
}

security.get('/', async (c) => {
  const user = c.get('user')!
  const session = c.get('session')
  return c.json({
    passkeys: (await passkeysOf(user.id)).map(describePasskey),
    totp: await totpEnabled(user.id),
    recoveryCodes: await recoveryCodesLeft(user.id),
    requiredBy: await organizationsRequiringFactor(user.id),
    // Whether changes can be made without signing in again
    recentSignIn: Boolean(session && Date.now() - session.createdAt.getTime() <= RECENT_SIGN_IN),
  })
})

// The first factor someone adds comes with recovery codes
async function codesForFirstFactor(userId: string, hadFactor: boolean) {
  return hadFactor ? undefined : await replaceRecoveryCodes(userId)
}

const setupLimit = (c: Parameters<typeof limitRequest>[0], userId: string) =>
  limitRequest(c, 'two-factor-setup', userId, 'You have changed your sign-in security a lot in a short time.')

security.post('/passkeys/options', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  if ((await passkeysOf(user.id)).length >= MAX_PASSKEYS) return c.json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` }, 409)
  const busy = await setupLimit(c, user.id)
  if (busy) return busy
  return c.json(await registrationOptions(user))
})

function checkName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { error: 'Give the passkey a name.' }
  if (name.length > MAX_PASSKEY_NAME) return { error: `Keep the name under ${MAX_PASSKEY_NAME} characters.` }
  return { name }
}

// { response, name }: what navigator.credentials.create() returned, as JSON
security.post('/passkeys', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { response?: RegistrationResponseJSON; name?: unknown } | null
  const named = checkName(body?.name ?? 'Passkey')
  if ('error' in named) return c.json({ error: named.error, field: 'name' }, 400)
  let credential: Awaited<ReturnType<typeof verifyRegistration>>
  try {
    credential = await verifyRegistration(user.id, body?.response as RegistrationResponseJSON)
  } catch (err) {
    if (err instanceof PasskeyError) return c.json({ error: err.message }, 400)
    throw err
  }
  const hadFactor = await hasSecondFactor(user.id)
  const [row] = await db
    .insert(schema.passkeys)
    .values({ userId: user.id, name: named.name, ...credential })
    .onConflictDoNothing()
    .returning()
  if (!row) return c.json({ error: 'This passkey is already added.' }, 409)
  log.info('Passkey added', { userId: user.id })
  return c.json({ passkey: describePasskey(row), recoveryCodes: await codesForFirstFactor(user.id, hadFactor) }, 201)
})

security.patch('/passkeys/:id', async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const named = checkName(body?.name)
  if ('error' in named) return c.json({ error: named.error, field: 'name' }, 400)
  const [row] = UUID_RE.test(id)
    ? await db
        .update(schema.passkeys)
        .set({ name: named.name })
        .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, user.id)))
        .returning()
    : []
  if (!row) return c.json({ error: 'That passkey was already removed.' }, 404)
  return c.json(describePasskey(row))
})

security.delete('/passkeys/:id', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  const id = c.req.param('id')
  const deleted = UUID_RE.test(id)
    ? await db
        .delete(schema.passkeys)
        .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, user.id)))
        .returning({ id: schema.passkeys.id })
    : []
  if (!deleted.length) return c.json({ error: 'That passkey was already removed.' }, 404)
  await dropCodesWithoutFactor(user.id)
  log.info('Passkey removed', { userId: user.id })
  return c.body(null, 204)
})

// Starts setting up an authenticator app: a new secret, shown as a QR code and as text. It counts
// only once a code from it is confirmed; until then, starting again replaces it.
security.post('/totp', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  if (await totpEnabled(user.id)) return c.json({ error: 'You already use an authenticator app. Remove it first to set up another one.' }, 409)
  const busy = await setupLimit(c, user.id)
  if (busy) return busy
  const secret = newTotpSecret()
  const sealed = await sealSecret(secret)
  await db
    .insert(schema.totpSecrets)
    .values({ userId: user.id, secret: sealed })
    .onConflictDoUpdate({ target: schema.totpSecrets.userId, set: { secret: sealed, lastStep: 0, createdAt: new Date() } })
  const issuer = (await instanceSettings()).instanceName || 'The Artifact'
  const uri = otpauthUrl(secret, issuer, user.email)
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  return c.json({
    secret: base32Encode(secret)
      .replace(/(.{4})/g, '$1 ')
      .trim(),
    uri,
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  })
})

// { code }: the first code from the app, which turns it on
security.post('/totp/confirm', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!code) return c.json({ error: 'Enter the 6-digit code from the app.', field: 'code' }, 400)
  const limited = await codeLimited(c, user.id)
  if (limited) return limited
  if (await totpEnabled(user.id)) return c.json({ error: 'Your authenticator app is already set up.' }, 409)
  const hadFactor = await hasSecondFactor(user.id)
  if (!(await useTotpCode(user.id, code, { confirmed: false }))) {
    await hit('two-factor', user.id)
    return c.json({ error: 'That code is wrong. Check the time on your phone, and enter the newest code.', field: 'code' }, 400)
  }
  await clearHits('two-factor', user.id)
  log.info('Authenticator app added', { userId: user.id })
  return c.json({ recoveryCodes: await codesForFirstFactor(user.id, hadFactor) })
})

security.delete('/totp', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  const deleted = await db.delete(schema.totpSecrets).where(eq(schema.totpSecrets.userId, user.id)).returning({ userId: schema.totpSecrets.userId })
  if (!deleted.length) return c.json({ error: 'You don’t use an authenticator app.' }, 404)
  await dropCodesWithoutFactor(user.id)
  log.info('Authenticator app removed', { userId: user.id })
  return c.body(null, 204)
})

// New recovery codes; the old ones stop working
security.post('/recovery-codes', requireRecentSignIn, async (c) => {
  const user = c.get('user')!
  if (!(await hasSecondFactor(user.id))) return c.json({ error: 'Add a passkey or an authenticator app first.' }, 409)
  const busy = await setupLimit(c, user.id)
  if (busy) return busy
  return c.json({ recoveryCodes: await replaceRecoveryCodes(user.id) })
})

// Where you're signed in, mounted at /api/me/sessions
export const sessions = new Hono<AuthEnv>()
sessions.use(requireUser)

const currentId = (c: Parameters<typeof getCookie>[0]) => {
  const token = getCookie(c, 'session')
  return token ? hashToken(token) : null
}

sessions.get('/', async (c) => {
  const user = c.get('user')!
  const current = currentId(c)
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id)).orderBy(desc(schema.sessions.createdAt))
  const now = Date.now()
  return c.json(
    rows
      .filter((s) => s.expiresAt.getTime() > now)
      .map((s) => ({
        id: sessionRef(s.id),
        ...describeDevice(s.userAgent),
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt ?? s.createdAt,
        current: s.id === current,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime()),
  )
})

// Signs out every other device
sessions.delete('/', async (c) => {
  const user = c.get('user')!
  const current = currentId(c)
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), current ? ne(schema.sessions.id, current) : undefined))
  return c.body(null, 204)
})

sessions.delete('/:id', async (c) => {
  const user = c.get('user')!
  const ref = c.req.param('id')
  const rows = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, user.id))
  const match = rows.find((s) => sessionRef(s.id) === ref)
  if (!match) return c.json({ error: 'That session has already ended.' }, 404)
  await db.delete(schema.sessions).where(eq(schema.sessions.id, match.id))
  if (match.id === currentId(c)) deleteCookie(c, 'session', { path: '/' })
  return c.body(null, 204)
})
