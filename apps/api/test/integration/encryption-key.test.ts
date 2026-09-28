import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { base32Decode, currentStep, totpCode } from '../../src/auth/totp.js'
import { signContentLink } from '../../src/content.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { checkServerSecrets, forgetServerSecrets, serverSecret } from '../../src/secrets.js'
import { prepare } from '../../src/startup.js'
import { call, createPage, createUser, sessionCookie, type TestUser } from './helpers.js'

const PASSWORD = 'correct horse battery'
const STEP = 30_000
const keyA = randomBytes(32)
const keyB = randomBytes(32)
const original = env.encryption

// A local webhook destination that keeps the signature and body of what it gets
let server: Server
let base = ''
let received: { signature: string; body: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      received.push({ signature: String(req.headers['x-artifact-signature']), body })
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

// TOTP codes depend on the clock, and each step's code signs in once
let clock = 0
beforeEach(() => {
  received = []
  clock = Math.floor(Date.now() / STEP) * STEP + STEP / 2
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
})

// Other test files share the database: leave no encrypted rows behind for them
afterEach(async () => {
  vi.useRealTimers()
  env.encryption = original
  await db.delete(schema.serverSecrets)
  forgetServerSecrets()
})

function useKeys(key: Buffer | null, previousKey: Buffer | null = null) {
  env.encryption = { key, previousKey }
  // A new process with these settings
  forgetServerSecrets()
}

const rows = async () => Object.fromEntries((await db.select().from(schema.serverSecrets)).map((r) => [r.name, r.value]))

async function signInWithCode(user: TestUser, secret: Buffer) {
  clock += STEP
  vi.setSystemTime(clock)
  const first = await call('/api/auth/password/login', { json: { email: user.email, password: PASSWORD } })
  expect(first.status).toBe(200)
  const pending = first.headers
    .getSetCookie()
    .find((c) => c.startsWith('sign_in_pending='))!
    .split(';')[0]
  return call('/api/auth/two-factor/code', { cookie: pending, json: { code: totpCode(secret, currentStep()) } })
}

// An account with an authenticator app, a webhook and a page, made while the rows are in the clear
async function setUp() {
  const user = await createUser()
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(schema.users.id, user.id))
  const start = await call('/api/me/security/totp', { method: 'POST', cookie: user.cookie })
  const totp = base32Decode(((await start.json()) as { secret: string }).secret)
  expect((await call('/api/me/security/totp/confirm', { cookie: user.cookie, json: { code: totpCode(totp, currentStep()) } })).status).toBe(200)

  const hook = await call('/api/me/webhooks', { cookie: user.cookie, json: { url: `${base}/hook`, events: ['page.published'] } })
  expect(hook.status).toBe(201)
  const { secret: webhookSecret } = (await hook.json()) as { secret: string }

  const page = await createPage(user)
  const now = Date.now()
  const link = await signContentLink(user.id, page, 1, now)
  return { user, totp, webhookSecret, page, now, link }
}

function signedBy(secret: string, r: { signature: string; body: string }) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(r.signature) ?? []
  return v1 === createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex')
}

describe('ENCRYPTION_KEY', () => {
  it('encrypts the rows in place once, and what they protect keeps working', async () => {
    const { user, totp, webhookSecret, page, now, link } = await setUp()
    const before = await rows()
    expect(Object.keys(before).sort()).toEqual(['content-links', 'two-factor', 'webhook-secrets'])
    for (const value of Object.values(before)) expect(value).not.toContain('.')

    useKeys(keyA)
    expect(await checkServerSecrets()).toBe(3)
    const after = await rows()
    for (const [name, value] of Object.entries(after)) {
      expect(value).toMatch(/^w1\./)
      expect(value).not.toContain(before[name])
    }
    // Running again, or in another process, changes nothing
    expect(await checkServerSecrets()).toBe(0)
    useKeys(keyA)
    expect(await checkServerSecrets()).toBe(0)
    expect(await rows()).toEqual(after)

    const res = await signInWithCode(user, totp)
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()
    expect(await signContentLink(user.id, page, 1, now)).toBe(link)
    expect((await call(`/api/artifacts/${page.slug}/download?version=1&token=${link}`)).status).toBe(200)
    await createPage(user)
    expect(received).toHaveLength(2)
    expect(signedBy(webhookSecret, received[1])).toBe(true)

    // Keys made from now on are stored encrypted from the start
    await serverSecret('export-links')
    expect((await rows())['export-links']).toMatch(/^w1\./)
  })

  it('encrypts rows in the clear as a process first uses a key, without a start of its own', async () => {
    const { user, page, now, link } = await setUp()
    useKeys(keyA)
    expect(await signContentLink(user.id, page, 1, now)).toBe(link)
    for (const value of Object.values(await rows())) expect(value).toMatch(/^w1\./)
  })

  it('stops the server from starting without the key or with another one, and keeps the rows', async () => {
    const { user, page } = await setUp()
    useKeys(keyA)
    await checkServerSecrets()
    const wrapped = await rows()

    useKeys(null)
    await expect(prepare()).rejects.toThrow(`is encrypted, but ENCRYPTION_KEY isn't set`)
    await expect(signContentLink(user.id, page, 1)).rejects.toThrow(`ENCRYPTION_KEY isn't set`)
    useKeys(keyB)
    await expect(prepare()).rejects.toThrow('was encrypted with another ENCRYPTION_KEY')
    await expect(serverSecret('export-links')).rejects.toThrow('was encrypted with another ENCRYPTION_KEY')
    expect(await rows()).toEqual(wrapped)
  })

  it('changes to a new key with the old one as ENCRYPTION_KEY_PREVIOUS', async () => {
    const { user, totp, page, now, link } = await setUp()
    useKeys(keyA)
    await checkServerSecrets()
    const underA = await rows()

    useKeys(keyB, keyA)
    await prepare()
    const underB = await rows()
    for (const name of Object.keys(underA)) expect(underB[name].split('.')[1]).not.toBe(underA[name].split('.')[1])

    // The old key is no longer needed, nor accepted
    useKeys(keyB)
    expect(await signContentLink(user.id, page, 1, now)).toBe(link)
    expect((await signInWithCode(user, totp)).status).toBe(200)
    useKeys(keyA)
    await expect(checkServerSecrets()).rejects.toThrow('was encrypted with another ENCRYPTION_KEY')
  })
})
