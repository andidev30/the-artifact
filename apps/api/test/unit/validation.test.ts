import { describe, expect, it } from 'vitest'
import { MAX_VERSION, parseVersion, SLUG_RE } from '../../src/validation.js'

describe('parseVersion', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    [String(MAX_VERSION), MAX_VERSION],
  ])('reads %s', (value, n) => {
    expect(parseVersion(value)).toBe(n)
  })

  it.each([undefined, '', '0', '-1', '+1', '01', '1.0', '1e0', '0x1', ' 1', '1 ', '١', String(MAX_VERSION + 1), '99999999999', '1'.repeat(400)])(
    'refuses %j',
    (value) => {
      expect(parseVersion(value)).toBeNull()
    },
  )
})

describe('SLUG_RE', () => {
  it('takes page ids and nothing else', () => {
    expect(SLUG_RE.test('k3v9x2m8pq')).toBe(true)
    for (const slug of ['', 'a\u0000b', 'A1', 'a-b', 'a/b', 'x'.repeat(65)]) expect(SLUG_RE.test(slug)).toBe(false)
  })
})
