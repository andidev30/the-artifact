import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { base32Decode, currentStep, totpCode } from '../../src/auth/totp.js'
import { downloadLink, signContentLink } from '../../src/content.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { Authenticator } from './authenticator.js'
import {
  addMember,
  call,
  callTool,
  connectAgent,
  createOrg,
  createPage,
  createUser,
  mcpRequest,
  pkcePair,
  registerClient,
  sessionCookie,
  startAuthorize,
  type TestUser,
} from './helpers.js'

const PASSWORD = 'correct horse battery'
const STEP = 30_000

// TOTP codes depend on the clock: tests start in the middle of a 30-second step and move it on by hand
let clock = 0
function tick(steps = 1) {
  clock += steps * STEP
  vi.setSystemTime(clock)
}

beforeEach(() => {
  clock = Math.floor(Date.now() / STEP) * STEP + STEP / 2
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The last session cookie a response sets: renewing the old session can come first
function newSession(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((c) => c.startsWith('session='))
    .at(-1)!
    .split(';')[0]
}

function pendingCookie(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('sign_in_pending='))
  const value = header?.split(';')[0]
  return value && value !== 'sign_in_pending=' ? value : null
}

async function withPassword(user: TestUser) {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(schema.users.id, user.id))
}

function login(email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
  return call('/api/auth/password/login', { json: { email, password, ...extra } })
}

async function enrolTotp(user: TestUser) {
  const start = await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })
  expect(start.status).toBe(200)
  const setup = (await start.json()) as { secret: string; uri: string; qr: string }
  const secret = base32Decode(setup.secret)
  const confirm = await call('/api/me/security/totp/confirm', { cookie: user.cookie, json: { code: totpCode(secret, currentStep()) } })
  expect(confirm.status).toBe(200)
  const { recoveryCodes } = (await confirm.json()) as { recoveryCodes: string[] }
  // The code just used can't sign in again; later tests start from the next step
  tick()
  return { secret, recoveryCodes, setup }
}

async function enrolPasskey(user: TestUser, name = 'Laptop') {
  const authenticator = new Authenticator()
  const options = await call('/api/me/security/passkeys/options', { method: 'POST', cookie: user.cookie })
  expect(options.status).toBe(200)
  const res = await call('/api/me/security/passkeys', { cookie: user.cookie, json: { name, response: authenticator.register(await options.json()) } })
  expect(res.status).toBe(201)
  return { authenticator, ...((await res.json()) as { passkey: { id: string; name: string }; recoveryCodes?: string[] }) }
}

// Password first, then the pending cookie that the two-factor page carries
async function firstFactor(user: TestUser) {
  const res = await login(user.email)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/login/two-factor' })
  expect(sessionCookie(res)).toBeNull()
  const pending = pendingCookie(res)
  expect(pending).toBeTruthy()
  return pending!
}

function sendCode(pending: string, code: string) {
  return call('/api/auth/two-factor/code', { cookie: pending, json: { code } })
}

describe('authenticator app', () => {
  it('is set up with a QR code and one code, and comes with ten recovery codes', async () => {
    const user = await createUser()
    const start = await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })
    const setup = (await start.json()) as { secret: string; uri: string; qr: string }
    expect(setup.uri).toMatch(
      /^otpauth:\/\/totp\/The%20Artifact:user\d+%40example\.com\?secret=[A-Z2-7]+&issuer=The\+Artifact&algorithm=SHA1&digits=6&period=30$/,
    )
    expect(setup.qr).toMatch(/^data:image\/svg\+xml;base64,/)
    // Stored encrypted, not as the secret people type in
    const [row] = await db.select().from(schema.totpSecrets).where(eq(schema.totpSecrets.userId, user.id))
    expect(row.secret).toMatch(/^v1\./)
    expect(row.secret).not.toContain(setup.secret.replaceAll(' ', ''))
    expect(row.confirmedAt).toBeNull()

    const secret = base32Decode(setup.secret)
    const wrong = await call('/api/me/security/totp/confirm', {
      cookie: user.cookie,
      json: { code: '000000' === totpCode(secret, currentStep()) ? '111111' : '000000' },
    })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ field: 'code' })

    const ok = await call('/api/me/security/totp/confirm', { cookie: user.cookie, json: { code: totpCode(secret, currentStep()) } })
    expect(ok.status).toBe(200)
    const { recoveryCodes } = (await ok.json()) as { recoveryCodes: string[] }
    expect(recoveryCodes).toHaveLength(10)
    expect(new Set(recoveryCodes).size).toBe(10)
    for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
    // Only hashes are kept
    const stored = await db.select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, user.id))
    expect(stored.map((r) => r.codeHash)).not.toContain(recoveryCodes[0])

    const security = await (await call('/api/me/security', { cookie: user.cookie })).json()
    expect(security).toMatchObject({ passkeys: [], totp: true, recoveryCodes: 10, requiredBy: [], recentSignIn: true })
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).twoFactor).toBe(true)

    // Setting up a second app needs the first one removed
    expect((await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })).status).toBe(409)
  })

  it('makes password sign-in ask for a code, and the pending sign-in opens nothing', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const page = await createPage(user)

    const pending = await firstFactor(user)
    // The pending cookie is not a session, under either name
    expect((await call('/api/me', { cookie: pending })).status).toBe(401)
    expect((await call('/api/me', { cookie: pending.replace('sign_in_pending=', 'session=') })).status).toBe(401)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: pending })).status).toBe(404)
    expect((await call('/api/artifacts?workspace=personal', { cookie: pending })).status).toBe(401)
    expect((await call('/api/me/security', { cookie: pending })).status).toBe(401)

    const methods = await call('/api/auth/two-factor', { cookie: pending })
    expect(await methods.json()).toEqual({ email: user.email, passkey: false, totp: true, recoveryCodes: true })

    const res = await sendCode(pending, totpCode(secret, currentStep()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/app' })
    const cookie = sessionCookie(res)
    expect(cookie).toBeTruthy()
    expect(pendingCookie(res)).toBeNull()
    expect((await call('/api/me', { cookie: cookie! })).status).toBe(200)
    // The pending sign-in is used up
    expect((await sendCode(pending, totpCode(secret, currentStep() + 1))).status).toBe(401)
    expect(await db.select().from(schema.pendingSignIns)).toHaveLength(0)
  })

  it('keeps where the person was going', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const res = await login(user.email, PASSWORD, { next: '/authorize?request=abc' })
    const pending = pendingCookie(res)!
    const done = await sendCode(pending, totpCode(secret, currentStep()))
    expect(await done.json()).toEqual({ redirect: 'http://localhost:5177/authorize?request=abc' })
  })

  it('accepts a code once, and one step of clock drift either way', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)

    const code = totpCode(secret, currentStep())
    expect((await sendCode(await firstFactor(user), code)).status).toBe(200)
    // The same code again, within its 30 seconds
    const replay = await sendCode(await firstFactor(user), code)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ field: 'code' })

    // A phone running 30 seconds behind
    tick(2)
    expect((await sendCode(await firstFactor(user), totpCode(secret, currentStep() - 1))).status).toBe(200)
    // ...and one running 30 seconds ahead
    tick(2)
    expect((await sendCode(await firstFactor(user), totpCode(secret, currentStep() + 1))).status).toBe(200)
    // Once a later step was used, earlier ones don't work
    expect((await sendCode(await firstFactor(user), totpCode(secret, currentStep()))).status).toBe(400)
    // Two steps off is too far
    tick(4)
    expect((await sendCode(await firstFactor(user), totpCode(secret, currentStep() - 2))).status).toBe(400)
    expect((await sendCode(await firstFactor(user), totpCode(secret, currentStep() + 2))).status).toBe(400)
  })

  it('limits wrong codes per account, and a right one clears the count', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const right = totpCode(secret, currentStep())
    const wrong = right === '123456' ? '654321' : '123456'
    const pending = await firstFactor(user)
    for (let i = 0; i < 10; i++) expect((await sendCode(pending, wrong)).status).toBe(400)
    const locked = await sendCode(pending, right)
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBeTruthy()
    expect(await locked.json()).toMatchObject({ code: 'too_many_attempts' })
    // A new pending sign-in doesn't reset it: the count is per account
    expect((await sendCode(await firstFactor(user), right)).status).toBe(429)
  })

  it('checks no more wrong codes than the limit when they arrive at the same time', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const right = totpCode(secret, currentStep())
    const pending = await firstFactor(user)
    const codes = Array.from({ length: 40 }, (_, i) => String(100000 + i)).filter((c) => c !== right)
    const statuses = await Promise.all(codes.map((code) => sendCode(pending, code).then((r) => r.status)))
    expect(statuses.filter((s) => s === 400)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(codes.length - 10)
    // Recovery codes count the same way
    const recovery = await Promise.all(Array.from({ length: 5 }, () => sendCode(pending, 'aaaaa-bbbbb').then((r) => r.status)))
    expect(recovery.every((s) => s === 429)).toBe(true)
  })

  it('counts wrong codes while setting the app up, attempts at once included', async () => {
    const user = await createUser()
    expect((await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })).status).toBe(200)
    const statuses = await Promise.all(
      Array.from(
        { length: 20 },
        async (_, i) => (await call('/api/me/security/totp/confirm', { cookie: user.cookie, json: { code: String(100000 + i) } })).status,
      ),
    )
    expect(statuses.filter((s) => s === 400).length).toBeLessThanOrEqual(10)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10)
  })

  it('can be removed, which turns two-factor sign-in off and drops the recovery codes', async () => {
    const user = await createUser()
    await withPassword(user)
    await enrolTotp(user)
    expect((await call('/api/me/security/totp', { method: 'DELETE', cookie: user.cookie })).status).toBe(204)
    expect(await db.select().from(schema.recoveryCodes)).toHaveLength(0)
    const res = await login(user.email)
    expect(sessionCookie(res)).toBeTruthy()
  })
})

describe('recovery codes', () => {
  it('each sign in once, and new ones replace the old', async () => {
    const user = await createUser()
    await withPassword(user)
    const { recoveryCodes } = await enrolTotp(user)

    const res = await sendCode(await firstFactor(user), recoveryCodes[0].toUpperCase().replace('-', ' '))
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()
    const again = await sendCode(await firstFactor(user), recoveryCodes[0])
    expect(again.status).toBe(400)
    expect((await (await call('/api/me/security', { cookie: user.cookie })).json()).recoveryCodes).toBe(9)

    const fresh = await call('/api/me/security/recovery-codes', { method: 'POST', cookie: user.cookie })
    const { recoveryCodes: replaced } = (await fresh.json()) as { recoveryCodes: string[] }
    expect(replaced).toHaveLength(10)
    expect((await sendCode(await firstFactor(user), recoveryCodes[1])).status).toBe(400)
    expect((await sendCode(await firstFactor(user), replaced[1])).status).toBe(200)
  })

  it('are only made for accounts with a second factor', async () => {
    const user = await createUser()
    expect((await call('/api/me/security/recovery-codes', { method: 'POST', cookie: user.cookie })).status).toBe(409)
  })
})

describe('changing sign-in security', () => {
  it('needs a sign-in from the last hour', async () => {
    const user = await createUser()
    await db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.sessions.userId, user.id))
    for (const [path, method] of [
      ['/api/me/security/totp', 'POST'],
      ['/api/me/security/totp/confirm', 'POST'],
      ['/api/me/security/totp', 'DELETE'],
      ['/api/me/security/passkeys/options', 'POST'],
      ['/api/me/security/passkeys', 'POST'],
      ['/api/me/security/recovery-codes', 'POST'],
    ]) {
      const res = await call(path, { method, cookie: user.cookie, json: {} })
      expect(res.status, path).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'reauth_required' })
    }
    expect((await (await call('/api/me/security', { cookie: user.cookie })).json()).recentSignIn).toBe(false)
  })

  it('adding a first password needs a recent sign-in, and does not make the session fresh', async () => {
    const user = await createUser()
    const signedIn = (minutes: number) =>
      db
        .update(schema.sessions)
        .set({ createdAt: new Date(Date.now() - minutes * 60 * 1000) })
        .where(eq(schema.sessions.userId, user.id))
    await signedIn(120)
    const stale = await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { password: 'a new password here' } })
    expect(stale.status).toBe(403)
    expect((await stale.json()).code).toBe('reauth_required')
    const [unchanged] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, user.id))
    expect(unchanged.passwordHash).toBeNull()

    await signedIn(50)
    const res = await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { password: 'a new password here' } })
    expect(res.status).toBe(204)
    const cookie = newSession(res)
    // The new session keeps the old sign-in time, so it stops counting as recent when the old one would
    const [session] = await db.select({ createdAt: schema.sessions.createdAt }).from(schema.sessions).where(eq(schema.sessions.userId, user.id))
    expect(Date.now() - session.createdAt.getTime()).toBeGreaterThan(49 * 60 * 1000)
    await signedIn(120)
    expect((await call('/api/me/security/totp', { method: 'POST', cookie })).status).toBe(403)

    // Knowing the current password does count
    const again = await call('/api/me/password', { method: 'PUT', cookie, json: { currentPassword: 'a new password here', password: 'another password' } })
    expect((await call('/api/me/security/totp', { method: 'POST', cookie: newSession(again) })).status).toBe(200)
  })

  it('a stale session of an account without a password cannot add one and sign in with it', async () => {
    const user = await createUser()
    await db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.sessions.userId, user.id))
    expect((await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { password: 'a password of theirs' } })).status).toBe(403)
    const login = await call('/api/auth/password/login', { json: { email: user.email, password: 'a password of theirs' } })
    expect(login.status).toBe(401)
    expect(sessionCookie(login)).toBeNull()
    // The session itself still works, and changing sign-in security still asks for a new sign-in
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(200)
    expect((await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })).status).toBe(403)
  })
})

describe('passkeys', () => {
  it('are added, named, listed, and sign in on their own', async () => {
    const user = await createUser({ name: 'Pat' })
    const options = await (await call('/api/me/security/passkeys/options', { method: 'POST', cookie: user.cookie })).json()
    expect(options).toMatchObject({ rp: { id: 'localhost', name: 'The Artifact' }, user: { name: user.email, displayName: 'Pat' }, attestation: 'none' })
    const authenticator = new Authenticator()
    const res = await call('/api/me/security/passkeys', { cookie: user.cookie, json: { name: '  Work   laptop ', response: authenticator.register(options) } })
    expect(res.status).toBe(201)
    const added = await res.json()
    expect(added.passkey).toMatchObject({ name: 'Work laptop', backedUp: false })
    expect(added.recoveryCodes).toHaveLength(10)

    const renamed = await call(`/api/me/security/passkeys/${added.passkey.id}`, { method: 'PATCH', cookie: user.cookie, json: { name: 'Old laptop' } })
    expect(await renamed.json()).toMatchObject({ name: 'Old laptop' })
    // A second one doesn't make new recovery codes
    const second = await enrolPasskey(user, 'Phone')
    expect(second.recoveryCodes).toBeUndefined()
    const listed = await (await call('/api/me/security', { cookie: user.cookie })).json()
    expect(listed.passkeys.map((p: { name: string }) => p.name)).toEqual(['Old laptop', 'Phone'])

    // Signing in with the passkey alone, no email address
    const signIn = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    expect(signIn).toMatchObject({ rpId: 'localhost', userVerification: 'required', allowCredentials: [] })
    const response = authenticator.authenticate(signIn)
    const done = await call('/api/auth/passkey', { json: { response, next: '/settings' } })
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ redirect: 'http://localhost:5177/settings' })
    const cookie = sessionCookie(done)
    expect(((await (await call('/api/me', { cookie: cookie! })).json()) as { email: string }).email).toBe(user.email)

    // The same response again: its challenge was used up
    expect((await call('/api/auth/passkey', { json: { response } })).status).toBe(400)
  })

  it('must be unlocked by the person to sign in alone', async () => {
    const user = await createUser()
    const { authenticator } = await enrolPasskey(user)
    const options = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    const res = await call('/api/auth/passkey', { json: { response: authenticator.authenticate(options, { userVerified: false }) } })
    expect(res.status).toBe(400)
    expect(sessionCookie(res)).toBeNull()
  })

  it('refuses responses for another site, unknown passkeys and forged signatures', async () => {
    const user = await createUser()
    const { authenticator } = await enrolPasskey(user)

    const options = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    expect((await call('/api/auth/passkey', { json: { response: authenticator.authenticate(options, { origin: 'https://evil.example' }) } })).status).toBe(400)

    const stranger = new Authenticator()
    const again = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    const unknown = await call('/api/auth/passkey', { json: { response: stranger.authenticate(again) } })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toMatch(/isn’t set up/)

    // A made-up challenge the server never handed out
    const forged = authenticator.authenticate({ challenge: 'bm90LWEtcmVhbC1jaGFsbGVuZ2U', rpId: 'localhost' })
    expect((await call('/api/auth/passkey', { json: { response: forged } })).status).toBe(400)
  })

  it('serve as the second factor after a password', async () => {
    const user = await createUser()
    await withPassword(user)
    const { authenticator } = await enrolPasskey(user)
    const other = await createUser()
    const { authenticator: othersKey } = await enrolPasskey(other)

    const pending = await firstFactor(user)
    expect(await (await call('/api/auth/two-factor', { cookie: pending })).json()).toMatchObject({ passkey: true, totp: false })
    const options = await (await call('/api/auth/two-factor/passkey/options', { method: 'POST', cookie: pending })).json()
    expect(options.allowCredentials).toEqual([{ id: authenticator.id, type: 'public-key', transports: ['internal'] }])

    // Someone else's passkey doesn't finish this person's sign-in
    const wrong = await call('/api/auth/two-factor/passkey', { cookie: pending, json: { response: othersKey.authenticate(options) } })
    expect(wrong.status).toBe(400)

    const again = await (await call('/api/auth/two-factor/passkey/options', { method: 'POST', cookie: pending })).json()
    // As a second factor, touching the key is enough
    const res = await call('/api/auth/two-factor/passkey', { cookie: pending, json: { response: authenticator.authenticate(again, { userVerified: false }) } })
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()
  })

  it('removing the last one turns two-factor sign-in off', async () => {
    const user = await createUser()
    await withPassword(user)
    const { passkey } = await enrolPasskey(user)
    expect((await call(`/api/me/security/passkeys/${passkey.id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(204)
    expect((await call(`/api/me/security/passkeys/${passkey.id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(404)
    expect(await db.select().from(schema.recoveryCodes)).toHaveLength(0)
    expect(sessionCookie(await login(user.email))).toBeTruthy()
  })

  it("can't be renamed or removed by someone else", async () => {
    const user = await createUser()
    const other = await createUser()
    const { passkey } = await enrolPasskey(user)
    expect((await call(`/api/me/security/passkeys/${passkey.id}`, { method: 'PATCH', cookie: other.cookie, json: { name: 'Mine' } })).status).toBe(404)
    expect((await call(`/api/me/security/passkeys/${passkey.id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404)
  })
})

describe('every first factor asks for the second', () => {
  it('email links', async () => {
    const user = await createUser()
    const { secret } = await enrolTotp(user)
    expect((await call('/api/auth/email', { json: { email: user.email } })).status).toBe(204)
    const link = new URL(vi.mocked(sendSignInLink).mock.calls[0][1])
    const res = await call('/api/auth/email/confirm', { json: { token: link.searchParams.get('token') } })
    expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/login/two-factor' })
    expect(sessionCookie(res)).toBeNull()
    expect((await sendCode(pendingCookie(res)!, totpCode(secret, currentStep()))).status).toBe(200)
  })

  it('links an admin passes on, on a server without email', async () => {
    const host = env.smtp.host
    env.smtp.host = ''
    try {
      const admin = await createUser({ admin: true })
      const user = await createUser()
      await enrolTotp(user)
      const made = await call('/api/admin/sign-up-links', { cookie: admin.cookie, json: { email: user.email } })
      const token = new URL(((await made.json()) as { link: string }).link).searchParams.get('token')
      const res = await call('/api/auth/email/confirm', { json: { token, password: 'a brand new password' } })
      expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/login/two-factor' })
      expect(sessionCookie(res)).toBeNull()
      // The new password signed the account out everywhere, and the factor is still there
      expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
      expect(await db.select().from(schema.totpSecrets)).toHaveLength(1)
    } finally {
      env.smtp.host = host
    }
  })

  it('Google', async () => {
    const google = { ...env.google }
    env.google.clientId = 'client'
    env.google.clientSecret = 'secret'
    try {
      const user = await createUser()
      await enrolTotp(user)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.includes('token')
            ? Response.json({ access_token: 'google-token' })
            : Response.json({ sub: 'google-123', email: user.email, email_verified: true, name: 'G' }),
        ),
      )
      const res = await call('/api/auth/google/callback?code=abc&state=s1', { cookie: 'google_state=s1; google_verifier=v1' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('http://localhost:5177/login/two-factor')
      expect(sessionCookie(res)).toBeNull()
      expect(pendingCookie(res)).toBeTruthy()
    } finally {
      Object.assign(env.google, google)
    }
  })

  it('but a passkey alone is enough', async () => {
    const user = await createUser()
    await enrolTotp(user)
    const { authenticator } = await enrolPasskey(user)
    const options = await (await call('/api/auth/passkey/options', { method: 'POST' })).json()
    const res = await call('/api/auth/passkey', { json: { response: authenticator.authenticate(options) } })
    expect(sessionCookie(res)).toBeTruthy()
  })

  it('and suspended accounts get no further', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const pending = await firstFactor(user)
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, user.id))
    expect((await sendCode(pending, totpCode(secret, currentStep()))).status).toBe(401)
  })

  it('pending sign-ins expire after ten minutes', async () => {
    const user = await createUser()
    await withPassword(user)
    const { secret } = await enrolTotp(user)
    const pending = await firstFactor(user)
    tick(21)
    expect((await sendCode(pending, totpCode(secret, currentStep()))).status).toBe(401)
    expect((await call('/api/auth/two-factor', { cookie: pending })).status).toBe(404)
  })
})

describe('organizations that require two-factor sign-in', () => {
  it('only owners and admins with a second factor turn it on', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    expect((await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: member.cookie, json: { requireTwoFactor: true } })).status).toBe(403)
    const blocked = await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { requireTwoFactor: true } })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: 'two_factor_needed' })
    await enrolTotp(owner)
    const res = await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { requireTwoFactor: true } })
    expect(res.status).toBe(200)
    const details = await res.json()
    expect(details.requireTwoFactor).toBe(true)
    expect(details.members.map((m: { twoFactor: boolean }) => m.twoFactor)).toEqual([true, false])
  })

  it('keep members without one out of the organization until they set one up', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    const page = await createPage(owner, { organizationId: org.id, visibility: 'organization' })
    const linkPage = await createPage(owner, { organizationId: org.id, visibility: 'link' })
    // Connected before the requirement
    const agent = await connectAgent(member, org.id)
    const personal = await connectAgent(member, null, 'cursor')
    const { token: accessToken } = await (await call('/api/me/access-tokens', { cookie: member.cookie, json: { name: 'CI', organizationId: org.id } })).json()
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    const frame = `/api/artifacts/${page.slug}/v/1/~${await signContentLink(member.id, row, 1)}/`
    const download = (await downloadLink(member.id, row, 1)).replace('http://localhost:5177', '')
    expect((await call(frame)).status).toBe(200)
    await enrolTotp(owner)
    await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { requireTwoFactor: true } })

    const me = await (await call('/api/me', { cookie: member.cookie })).json()
    expect(me.organizations).toMatchObject([{ id: org.id, requireTwoFactor: true, blocked: true }])
    const gallery = await call(`/api/artifacts?workspace=${org.id}`, { cookie: member.cookie })
    expect(gallery.status).toBe(403)
    expect(await gallery.json()).toMatchObject({ code: 'two_factor_required', error: expect.stringContaining('Acme Inc requires two-factor sign-in') })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: member.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${linkPage.slug}`, { cookie: member.cookie })).status).toBe(200)
    expect((await call(`/api/folders?workspace=${org.id}`, { cookie: member.cookie })).status).toBe(404)
    expect((await call(`/api/organizations/${org.id}`, { cookie: member.cookie })).status).toBe(403)
    const token = await call('/api/me/access-tokens', { cookie: member.cookie, json: { name: 'CI', organizationId: org.id } })
    expect(token.status).toBe(403)
    expect(await token.json()).toMatchObject({ code: 'two_factor_required', field: 'organizationId' })

    // Connecting an agent to it waits too
    const client = await registerClient()
    const requestId = await startAuthorize(client.client_id, pkcePair().challenge)
    const consent = await (await call(`/api/oauth/requests/${requestId}`, { cookie: member.cookie })).json()
    expect(consent.workspaces[0]).toEqual({ id: org.id, name: 'Acme Inc', blocked: true })
    expect((await call(`/api/oauth/requests/${requestId}/approve`, { cookie: member.cookie, json: { organizationId: org.id } })).status).toBe(403)

    // Agents and access tokens for it are refused, and the rest can't reach its pages
    expect((await mcpRequest(agent.access_token, 'tools/list')).status).toBe(401)
    expect((await call('/api/whoami', { bearer: accessToken })).status).toBe(401)
    const refresh = await call('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: agent.refresh_token } })
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('requires two-factor sign-in') })
    expect(await callTool(personal.access_token, 'get_artifact', { artifact_id: page.slug })).toMatchObject({ isError: true })
    expect(await callTool(personal.access_token, 'rename_artifact', { artifact_id: page.slug, title: 'Renamed' })).toMatchObject({ isError: true })
    expect((await call(frame)).status).toBe(404)
    expect((await call(download)).status).toBe(404)
    expect((await callTool(personal.access_token, 'list_artifacts', {})).isError).toBe(false)

    // Setting up a factor lets them back in, with the same session
    await enrolTotp(member)
    expect((await call(`/api/artifacts?workspace=${org.id}`, { cookie: member.cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: member.cookie })).status).toBe(200)
    expect((await (await call('/api/me', { cookie: member.cookie })).json()).organizations[0].blocked).toBe(false)
    // and their agents, access tokens and links work again
    expect((await callTool(agent.access_token, 'list_artifacts', {})).text).toContain(page.slug)
    expect((await call('/api/whoami', { bearer: accessToken })).status).toBe(200)
    expect((await call('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: agent.refresh_token } })).status).toBe(200)
    expect((await callTool(agent.access_token, 'get_artifact', { artifact_id: page.slug })).isError).toBe(false)
    // An agent for another workspace opens only pages shared with the person directly or by link
    expect((await callTool(personal.access_token, 'get_artifact', { artifact_id: page.slug })).isError).toBe(true)
    expect((await callTool(personal.access_token, 'get_artifact', { artifact_id: linkPage.slug })).isError).toBe(false)
    expect((await call(frame)).status).toBe(200)
    expect((await call(download)).status).toBe(200)
  })

  it('still let blocked members leave, and send them to set up a factor when they sign in', async () => {
    const owner = await createUser()
    const member = await createUser()
    await withPassword(member)
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    await enrolTotp(owner)
    await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { requireTwoFactor: true } })

    const res = await login(member.email)
    expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/settings?two-factor=required#security' })
    const withNext = await login(member.email, PASSWORD, { next: '/a/abc' })
    expect(await withNext.json()).toEqual({ redirect: 'http://localhost:5177/a/abc' })
    expect((await (await call('/api/me/security', { cookie: member.cookie })).json()).requiredBy).toEqual([{ id: org.id, name: 'Acme Inc' }])

    expect((await call(`/api/organizations/${org.id}/members/${member.id}`, { method: 'DELETE', cookie: member.cookie })).status).toBe(204)
  })
})

describe('sessions', () => {
  it('are listed with their browser, and other devices can be signed out', async () => {
    const user = await createUser()
    await withPassword(user)
    const phone = sessionCookie(
      await call('/api/auth/password/login', {
        json: { email: user.email, password: PASSWORD },
        headers: {
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        },
      }),
    )!
    const laptop = sessionCookie(
      await call('/api/auth/password/login', {
        json: { email: user.email, password: PASSWORD },
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0' },
      }),
    )!

    const list = await (await call('/api/me/sessions', { cookie: laptop })).json()
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ browser: 'Firefox', os: 'Windows', current: true })
    expect(list.find((s: { browser: string }) => s.browser === 'Safari')).toMatchObject({ os: 'iOS', current: false })
    // No session hashes leave the server
    const hashes = (await db.select().from(schema.sessions)).map((s) => s.id)
    for (const s of list) expect(hashes).not.toContain(s.id)

    const iphone = list.find((s: { browser: string }) => s.browser === 'Safari')
    expect((await call(`/api/me/sessions/${iphone.id}`, { method: 'DELETE', cookie: laptop })).status).toBe(204)
    expect((await call('/api/me', { cookie: phone })).status).toBe(401)
    expect((await call(`/api/me/sessions/${iphone.id}`, { method: 'DELETE', cookie: laptop })).status).toBe(404)

    expect((await call('/api/me/sessions', { method: 'DELETE', cookie: laptop })).status).toBe(204)
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
    expect((await call('/api/me', { cookie: laptop })).status).toBe(200)
    expect(await (await call('/api/me/sessions', { cookie: laptop })).json()).toHaveLength(1)
  })

  it("can't end someone else's session", async () => {
    const user = await createUser()
    const other = await createUser()
    const [theirs] = await (await call('/api/me/sessions', { cookie: other.cookie })).json()
    expect((await call(`/api/me/sessions/${theirs.id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(404)
    expect((await call('/api/me', { cookie: other.cookie })).status).toBe(200)
  })

  it('note when they were last used', async () => {
    const user = await createUser()
    await db
      .update(schema.sessions)
      .set({ lastActiveAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.sessions.userId, user.id))
    await call('/api/me', { cookie: user.cookie })
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))
    expect(Date.now() - row.lastActiveAt!.getTime()).toBeLessThan(60_000)
  })
})

describe('an admin resetting two-factor sign-in', () => {
  it('removes every factor and signs the person out, and is for admins only', async () => {
    const admin = await createUser({ admin: true })
    const user = await createUser()
    await withPassword(user)
    await enrolTotp(user)
    await enrolPasskey(user)
    expect((await call(`/api/admin/users/${user.id}/reset-two-factor`, { method: 'POST', cookie: user.cookie })).status).toBe(403)
    expect((await call(`/api/admin/users/${admin.id}/reset-two-factor`, { method: 'POST', cookie: admin.cookie })).status).toBe(409)

    const listed = await (await call('/api/admin/users', { cookie: admin.cookie })).json()
    expect(listed.users.find((u: { id: string }) => u.id === user.id).twoFactor).toBe(true)

    const res = await call(`/api/admin/users/${user.id}/reset-two-factor`, { method: 'POST', cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: user.id, twoFactor: false })
    expect(await db.select().from(schema.passkeys)).toHaveLength(0)
    expect(await db.select().from(schema.totpSecrets)).toHaveLength(0)
    expect(await db.select().from(schema.recoveryCodes)).toHaveLength(0)
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
    // Their password alone signs in again
    expect(sessionCookie(await login(user.email))).toBeTruthy()
  })
})

describe('second-factor limits from one network', () => {
  it('count passkey sign-ins and codes together', async () => {
    const rateLimits = env.rateLimits
    env.rateLimits = 'two-factor-ip=3/15m'
    env.trustProxy = 1
    try {
      const headers = { 'x-forwarded-for': '203.0.113.9' }
      for (let i = 0; i < 3; i++) expect((await call('/api/auth/passkey/options', { method: 'POST', headers })).status).toBe(200)
      const res = await call('/api/auth/passkey/options', { method: 'POST', headers })
      expect(res.status).toBe(429)
      expect((await call('/api/auth/two-factor/code', { headers, json: { code: '123456' } })).status).toBe(429)
    } finally {
      env.rateLimits = rateLimits
      env.trustProxy = 0
    }
  })
})
