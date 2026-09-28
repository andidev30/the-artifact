import { generateKeyPairSync } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { readSigningKey, signLicense, type SigningKey } from '../../src/ee/licenses.js'
import { env } from '../../src/env.js'
import { LICENSE_PUBLIC_KEYS, enterprise, hasEnterprise } from '../../src/license.js'
import { call, createUser, type TestUser } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const original = { selfHosted: env.selfHosted, licenseSigningKey: env.licenseSigningKey }

function newSigningKey(): { der: string; key: SigningKey } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  return { der, key: readSigningKey(der)! }
}

const trusted = newSigningKey()

beforeEach(() => {
  LICENSE_PUBLIC_KEYS[trusted.key.keyId] = trusted.key.publicKey
})

afterEach(() => {
  env.selfHosted = original.selfHosted
  env.licenseSigningKey = original.licenseSigningKey
  for (const id of Object.keys(LICENSE_PUBLIC_KEYS)) delete LICENSE_PUBLIC_KEYS[id]
})

function licenseKey(opts: { expiresAt?: Date; seats?: number; signer?: SigningKey } = {}) {
  return signLicense(
    {
      id: randomUUID(),
      customer: 'Acme Inc',
      email: 'it@acme.example',
      seats: opts.seats ?? 10,
      issuedAt: new Date().toISOString(),
      expiresAt: (opts.expiresAt ?? new Date(Date.now() + 365 * DAY)).toISOString(),
    },
    opts.signer ?? trusted.key,
  )
}

// Stores a key directly, as an install that saved it earlier would have it
async function storeKey(key: string) {
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', licenseKey: key })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set: { licenseKey: key } })
}

type LicenseState = {
  status: string
  invalid: string | null
  license: { customer: string; email: string; seats: number; expiresAt: string; graceEndsAt: string } | null
  seatsInUse: number
}

describe('entering a license key on a self-hosted install', () => {
  let admin: TestUser

  beforeEach(async () => {
    env.selfHosted = true
    admin = await createUser({ admin: true })
  })

  it('starts with no license and enterprise features off', async () => {
    const res = await call('/api/admin/license', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'none', invalid: null, license: null, seatsInUse: 1 })
    expect(await hasEnterprise()).toBe(false)
  })

  it('saves a valid key, shows who it is for and turns enterprise features on', async () => {
    await createUser()
    const res = await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: `\n ${licenseKey({ seats: 25 })} \n` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LicenseState
    expect(body.status).toBe('active')
    expect(body.license).toMatchObject({ customer: 'Acme Inc', email: 'it@acme.example', seats: 25 })
    expect(body.seatsInUse).toBe(2)
    expect(await hasEnterprise()).toBe(true)

    const [row] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1))
    expect(row.licenseKey?.startsWith('art_lic_')).toBe(true)
    expect(row.licenseUpdatedBy).toBe(admin.id)
    // Saving a key leaves sign-up as open as it was without settings
    expect(row.signupPolicy).toBe('open')
  })

  it('keeps the sign-up settings when a key is added', async () => {
    await call('/api/admin/settings', { method: 'PUT', cookie: admin.cookie, json: { signupPolicy: 'invite-only', instanceName: 'Acme pages' } })
    await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey() } })
    const settings = await (await call('/api/admin/settings', { cookie: admin.cookie })).json()
    expect(settings).toMatchObject({ signupPolicy: 'invite-only', instanceName: 'Acme pages' })
  })

  it('replaces the key with a newer one', async () => {
    await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey({ seats: 5 }) } })
    const res = await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey({ seats: 50 }) } })
    expect(((await res.json()) as LicenseState).license?.seats).toBe(50)
  })

  it('removes the key, which turns enterprise features off and deletes nothing else', async () => {
    await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey() } })
    const res = await call('/api/admin/license', { method: 'DELETE', cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(((await res.json()) as LicenseState).status).toBe('none')
    expect(await hasEnterprise()).toBe(false)
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('warns about seats but never blocks anyone', async () => {
    await createUser()
    await createUser()
    const res = await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey({ seats: 1 }) } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LicenseState
    expect(body.seatsInUse).toBe(3)
    expect(body.license?.seats).toBe(1)
    expect(await hasEnterprise()).toBe(true)
    const late = await createUser()
    expect((await call('/api/me', { cookie: late.cookie })).status).toBe(200)
  })

  it('does not count suspended people against the seats', async () => {
    const other = await createUser()
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, other.id))
    const body = (await (await call('/api/admin/license', { cookie: admin.cookie })).json()) as LicenseState
    expect(body.seatsInUse).toBe(1)
  })

  it.each([
    ['empty', '', 'Paste the license key.'],
    ['not a key', 'hello there', 'not a license key'],
    ['cut short', () => licenseKey().slice(0, -12), 'changed or is incomplete'],
    ['tampered', () => tamper(licenseKey()), 'changed or is incomplete'],
    ['signed by an unknown key', () => licenseKey({ signer: newSigningKey().key }), 'signed by a key this version doesn’t know'],
    ['expired', () => licenseKey({ expiresAt: new Date(Date.now() - DAY) }), 'expired on'],
  ] as [string, string | (() => string), string][])('rejects a key that is %s', async (_, key, message) => {
    const res = await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: typeof key === 'function' ? key() : key } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.field).toBe('key')
    expect(body.error).toContain(message)
    expect(await hasEnterprise()).toBe(false)
  })

  it('gives a grace period after the key expires, then turns enterprise features off', async () => {
    const expiresAt = new Date(Date.now() + DAY)
    await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key: licenseKey({ expiresAt }) } })
    expect((await enterprise(new Date(expiresAt.getTime() + 5 * DAY))).status).toBe('grace')
    expect(await hasEnterprise(new Date(expiresAt.getTime() + 5 * DAY))).toBe(true)
    expect((await enterprise(new Date(expiresAt.getTime() + 15 * DAY))).status).toBe('expired')
    expect(await hasEnterprise(new Date(expiresAt.getTime() + 15 * DAY))).toBe(false)
  })

  it('reports a stored key in its grace period', async () => {
    await storeKey(licenseKey({ expiresAt: new Date(Date.now() - 3 * DAY) }))
    const body = (await (await call('/api/admin/license', { cookie: admin.cookie })).json()) as LicenseState
    expect(body.status).toBe('grace')
    expect(new Date(body.license!.graceEndsAt).getTime() - new Date(body.license!.expiresAt).getTime()).toBe(14 * DAY)
  })

  it('ignores a stored key that was edited in the database', async () => {
    await storeKey(tamper(licenseKey()))
    const body = (await (await call('/api/admin/license', { cookie: admin.cookie })).json()) as LicenseState
    expect(body.status).toBe('none')
    expect(body.invalid).toContain('changed or is incomplete')
    expect(await hasEnterprise()).toBe(false)
  })

  it('is for instance admins only', async () => {
    const someone = await createUser()
    for (const [method, json] of [['GET'], ['PUT', { key: licenseKey() }], ['DELETE']] as [string, unknown?][]) {
      expect((await call('/api/admin/license', { method, json, cookie: someone.cookie })).status).toBe(403)
      expect((await call('/api/admin/license', { method, json })).status).toBe(401)
    }
  })

  it('has no key issuing on a self-hosted install', async () => {
    env.licenseSigningKey = trusted.der
    expect((await call('/api/admin/issued-licenses', { cookie: admin.cookie })).status).toBe(404)
    const res = await call('/api/admin/issued-licenses', {
      cookie: admin.cookie,
      json: { customerName: 'Acme', customerEmail: 'it@acme.example', seats: 5, expiresOn: '2099-01-01' },
    })
    expect(res.status).toBe(404)
  })
})

function tamper(key: string) {
  const [body, sig] = key.slice('art_lic_'.length).split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  payload.seats = 100_000
  return `art_lic_${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
}

describe('issuing license keys on the hosted service', () => {
  let admin: TestUser
  const form = { customerName: '  Acme   Inc ', customerEmail: 'IT@Acme.Example', seats: 25, expiresOn: '2099-06-30' }

  beforeEach(async () => {
    env.selfHosted = false
    env.licenseSigningKey = trusted.der
    admin = await createUser({ admin: true })
  })

  it('issues a key that a self-hosted install accepts', async () => {
    const res = await call('/api/admin/issued-licenses', { cookie: admin.cookie, json: form })
    expect(res.status).toBe(201)
    const { key, license } = (await res.json()) as { key: string; license: Record<string, unknown> }
    expect(license).toMatchObject({ customerName: 'Acme Inc', customerEmail: 'it@acme.example', seats: 25, expiresAt: '2099-06-30T23:59:59.999Z' })
    expect(license.issuedBy).toBe(admin.email)

    const list = (await (await call('/api/admin/issued-licenses', { cookie: admin.cookie })).json()) as { available: boolean; licenses: unknown[] }
    expect(list.available).toBe(true)
    expect(list.licenses).toEqual([license])
    // The key itself isn't kept
    const [row] = await db.select().from(schema.issuedLicenses)
    expect(JSON.stringify(row)).not.toContain(key.split('.')[1])

    env.selfHosted = true
    const saved = await call('/api/admin/license', { method: 'PUT', cookie: admin.cookie, json: { key } })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as LicenseState).license).toMatchObject({ customer: 'Acme Inc', seats: 25, email: 'it@acme.example' })
    expect(await hasEnterprise()).toBe(true)
  })

  it('keeps enterprise features off on the hosted service, whatever is stored', async () => {
    await storeKey(licenseKey())
    expect(await enterprise()).toEqual({ status: 'none', license: null, invalid: null })
    expect(await hasEnterprise()).toBe(false)
    expect((await call('/api/admin/license', { cookie: admin.cookie })).status).toBe(404)
  })

  it('says why keys cannot be issued without LICENSE_SIGNING_KEY', async () => {
    env.licenseSigningKey = ''
    const list = (await (await call('/api/admin/issued-licenses', { cookie: admin.cookie })).json()) as { available: boolean; reason: string }
    expect(list).toMatchObject({ available: false, reason: expect.stringContaining('LICENSE_SIGNING_KEY') })
    const res = await call('/api/admin/issued-licenses', { cookie: admin.cookie, json: form })
    expect(res.status).toBe(409)
    expect(await db.select().from(schema.issuedLicenses)).toHaveLength(0)
  })

  it('refuses a signing key that is not valid or whose public key is not in the code', async () => {
    env.licenseSigningKey = 'not-a-key'
    let list = (await (await call('/api/admin/issued-licenses', { cookie: admin.cookie })).json()) as { available: boolean; reason: string }
    expect(list.reason).toContain('not an Ed25519 private key')

    env.licenseSigningKey = newSigningKey().der
    list = (await (await call('/api/admin/issued-licenses', { cookie: admin.cookie })).json()) as { available: boolean; reason: string }
    expect(list).toMatchObject({ available: false, reason: expect.stringContaining('LICENSE_PUBLIC_KEYS') })
  })

  it.each([
    [{ customerName: ' ' }, 'customerName'],
    [{ customerEmail: 'nope' }, 'customerEmail'],
    [{ seats: 0 }, 'seats'],
    [{ seats: 2.5 }, 'seats'],
    [{ expiresOn: 'soon' }, 'expiresOn'],
    [{ expiresOn: '2020-01-01' }, 'expiresOn'],
  ] as [Record<string, unknown>, string][])('names the field that is wrong: %o', async (change, field) => {
    const res = await call('/api/admin/issued-licenses', { cookie: admin.cookie, json: { ...form, ...change } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { field: string }).field).toBe(field)
  })

  it('is for instance admins only', async () => {
    const someone = await createUser()
    expect((await call('/api/admin/issued-licenses', { cookie: someone.cookie })).status).toBe(403)
    expect((await call('/api/admin/issued-licenses', { cookie: someone.cookie, json: form })).status).toBe(403)
    expect((await call('/api/admin/issued-licenses')).status).toBe(401)
  })
})
