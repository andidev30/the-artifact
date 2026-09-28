import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readSigningKey, signLicense } from '../../src/ee/licenses.js'
import { GRACE_DAYS, LICENSE_PREFIX, graceEndsAt, licenseKeyId, licenseStatus, parseLicense } from '../../src/license.js'

function makeKey() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  if (!key) throw new Error('no key')
  return key
}

const signer = makeKey()
const keys = { [signer.keyId]: signer.publicKey }
const DAY = 24 * 60 * 60 * 1000

const fields = {
  id: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11',
  customer: 'Acme Inc',
  email: 'it@acme.example',
  seats: 25,
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2027-01-01T23:59:59.999Z',
}

describe('license keys', () => {
  it('signs a key that verifies and carries its fields', () => {
    const key = signLicense(fields, signer)
    expect(key.startsWith(LICENSE_PREFIX)).toBe(true)
    const parsed = parseLicense(key, keys)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.license).toMatchObject({ id: fields.id, customer: 'Acme Inc', email: 'it@acme.example', seats: 25, signingKeyId: signer.keyId })
    expect(parsed.license.expiresAt.toISOString()).toBe(fields.expiresAt)
  })

  it('ignores whitespace and line breaks from pasting', () => {
    const key = signLicense(fields, signer)
    const wrapped = `  ${key.slice(0, 40)}\n${key.slice(40, 90)}\r\n ${key.slice(90)}\n`
    expect(parseLicense(wrapped, keys).ok).toBe(true)
  })

  it('names the key id after the public key', () => {
    expect(signer.keyId).toBe(licenseKeyId(signer.publicKey))
    expect(signer.keyId).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('rejects a key whose payload was changed', () => {
    const key = signLicense(fields, signer)
    const [body, sig] = key.slice(LICENSE_PREFIX.length).split('.')
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    payload.seats = 5000
    const forged = `${LICENSE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
    expect(parseLicense(forged, keys)).toEqual({ ok: false, error: expect.stringContaining('changed or is incomplete') })
  })

  it('rejects a key whose signature was changed or cut short', () => {
    const key = signLicense(fields, signer)
    const flipped = key.slice(0, -2) + (key.at(-2) === 'A' ? 'B' : 'A') + key.at(-1)
    expect(parseLicense(flipped, keys).ok).toBe(false)
    expect(parseLicense(key.slice(0, -10), keys).ok).toBe(false)
  })

  it('rejects a key signed by a key the code does not list', () => {
    const other = makeKey()
    const key = signLicense(fields, other)
    expect(parseLicense(key, keys)).toEqual({ ok: false, error: expect.stringContaining('signed by a key this version doesn’t know') })
  })

  it('rejects a key that claims a listed key id but was signed by another key', () => {
    const other = makeKey()
    const key = signLicense(fields, { ...other, keyId: signer.keyId })
    expect(parseLicense(key, keys)).toEqual({ ok: false, error: expect.stringContaining('changed or is incomplete') })
  })

  it('rejects text that is not a key', () => {
    for (const input of ['', 'hello', 'art_lic_', 'art_lic_abc', 'art_lic_a.b.c', 'art_lic_ab$.cd', `x${signLicense(fields, signer)}`]) {
      const parsed = parseLicense(input, keys)
      expect(parsed.ok, input).toBe(false)
    }
    expect(parseLicense('hello', keys)).toEqual({ ok: false, error: expect.stringContaining('not a license key') })
  })

  it('rejects a key of another format version', () => {
    const key = signLicense(fields, signer)
    const body = key.slice(LICENSE_PREFIX.length).split('.')[0]
    const payload = { ...JSON.parse(Buffer.from(body, 'base64url').toString()), v: 2 }
    const signed = LICENSE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
    const v2 = `${signed}.${sign(null, Buffer.from(signed), signer.privateKey).toString('base64url')}`
    expect(parseLicense(v2, keys)).toEqual({ ok: false, error: expect.stringContaining('different version') })
  })

  it('rejects a private key that is not Ed25519', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    expect(readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))).toBeNull()
    expect(readSigningKey('not a key')).toBeNull()
    expect(readSigningKey('')).toBeNull()
  })

  it('reads a PEM private key as well', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(readSigningKey(pem)?.keyId).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })
})

describe('license status', () => {
  const expiresAt = new Date('2027-01-01T23:59:59.999Z')

  it('is none without a license', () => {
    expect(licenseStatus(null)).toBe('none')
  })

  it('is active until it expires', () => {
    expect(licenseStatus({ expiresAt }, new Date(expiresAt.getTime() - 1))).toBe('active')
  })

  it(`gives ${GRACE_DAYS} days of grace after expiry`, () => {
    expect(licenseStatus({ expiresAt }, expiresAt)).toBe('grace')
    expect(licenseStatus({ expiresAt }, new Date(expiresAt.getTime() + 13 * DAY))).toBe('grace')
    expect(graceEndsAt({ expiresAt }).getTime()).toBe(expiresAt.getTime() + 14 * DAY)
  })

  it('is expired after the grace period', () => {
    expect(licenseStatus({ expiresAt }, graceEndsAt({ expiresAt }))).toBe('expired')
    expect(licenseStatus({ expiresAt }, new Date(expiresAt.getTime() + 400 * DAY))).toBe('expired')
  })
})
