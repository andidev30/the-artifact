import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptionKey, encryptionKeys } from '../../src/env.js'
import { unwrapSecret, wrapSecret } from '../../src/secrets.js'

const key = randomBytes(32)
const other = randomBytes(32)
const secret = randomBytes(32)

describe('encryptionKey', () => {
  it('reads 32 bytes in base64, base64url or hex', () => {
    expect(encryptionKey(key.toString('base64'), 'ENCRYPTION_KEY')).toEqual(key)
    expect(encryptionKey(key.toString('base64url'), 'ENCRYPTION_KEY')).toEqual(key)
    expect(encryptionKey(` ${key.toString('hex').toUpperCase()}\n`, 'ENCRYPTION_KEY')).toEqual(key)
    expect(encryptionKey(undefined, 'ENCRYPTION_KEY')).toBeNull()
    expect(encryptionKey('  ', 'ENCRYPTION_KEY')).toBeNull()
  })

  it.each([
    'secret',
    randomBytes(16).toString('base64'),
    randomBytes(33).toString('base64'),
    randomBytes(31).toString('hex'),
    `${key.toString('base64').slice(0, 42)}!=`,
    `${key.toString('hex').slice(0, 63)}g`,
  ])('refuses %j', (value) => {
    expect(() => encryptionKey(value, 'ENCRYPTION_KEY')).toThrow('ENCRYPTION_KEY must be 32 random bytes in base64 or hex')
  })

  it('takes a previous key only next to a current one', () => {
    expect(encryptionKeys(key.toString('base64'), other.toString('base64'))).toEqual({ key, previousKey: other })
    expect(() => encryptionKeys('', other.toString('base64'))).toThrow('set the new key as ENCRYPTION_KEY too')
    expect(() => encryptionKeys(key.toString('base64'), 'nope')).toThrow('ENCRYPTION_KEY_PREVIOUS must be')
  })
})

describe('wrapping server secrets', () => {
  it('opens what it wrapped, and asks for no rewrite', () => {
    const stored = wrapSecret('content-links', secret, key)
    expect(stored).toMatch(/^w1\.[\w-]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(stored).not.toContain(secret.toString('base64url'))
    expect(wrapSecret('content-links', secret, key)).not.toBe(stored)
    expect(unwrapSecret('content-links', stored, { key, previousKey: null })).toEqual({ secret, stale: false })
  })

  it('reads rows in the clear, and asks to wrap them once there is a key', () => {
    const plain = secret.toString('base64url')
    expect(unwrapSecret('two-factor', plain, { key: null, previousKey: null })).toEqual({ secret, stale: false })
    expect(unwrapSecret('two-factor', plain, { key, previousKey: null })).toEqual({ secret, stale: true })
  })

  it('refuses a wrapped row without the key or with another one', () => {
    const stored = wrapSecret('two-factor', secret, key)
    expect(() => unwrapSecret('two-factor', stored, { key: null, previousKey: null })).toThrow(
      `The server secret "two-factor" is encrypted, but ENCRYPTION_KEY isn't set`,
    )
    expect(() => unwrapSecret('two-factor', stored, { key: other, previousKey: null })).toThrow(
      'The server secret "two-factor" was encrypted with another ENCRYPTION_KEY',
    )
  })

  it('opens rows under the previous key while keys change, and asks to wrap them again', () => {
    const stored = wrapSecret('webhooks', secret, other)
    expect(unwrapSecret('webhooks', stored, { key, previousKey: other })).toEqual({ secret, stale: true })
    const current = wrapSecret('webhooks', secret, key)
    expect(unwrapSecret('webhooks', current, { key, previousKey: other })).toEqual({ secret, stale: false })
  })

  it('refuses a value moved to another row, a changed one and unknown formats', () => {
    const stored = wrapSecret('content-links', secret, key)
    const keys = { key, previousKey: null }
    expect(() => unwrapSecret('export-links', stored, keys)).toThrow('the row is damaged')
    const parts = stored.split('.')
    const body = Buffer.from(parts[3], 'base64url')
    body[0] ^= 1
    parts[3] = body.toString('base64url')
    expect(() => unwrapSecret('content-links', parts.join('.'), keys)).toThrow('the row is damaged')
    expect(() => unwrapSecret('content-links', `w2${stored.slice(2)}`, keys)).toThrow('unknown format')
    expect(() => unwrapSecret('content-links', `${stored}.x`, keys)).toThrow('unknown format')
  })
})
