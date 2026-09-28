import { describe, expect, it } from 'vitest'
import { ACCOUNT_EMAIL_RE, EMAIL_RE } from '../../src/validation.js'

describe('EMAIL_RE', () => {
  it.each(['ana@example.com', 'ana.lee+pages@mail.example.co.uk', 'o_brien-2@sub.example.io', 'renée@exemple.fr', "o'neil@example.com"])(
    'accepts %s',
    (email) => {
      expect(EMAIL_RE.test(email)).toBe(true)
    },
  )

  it.each([
    'x"@example.com',
    '"x"@example.com',
    'x<victim@example.com>',
    'Ana <ana@example.com>',
    'a,b@example.com',
    'a;b@example.com',
    'a b@example.com',
    'a:b@example.com',
    'a\\b@example.com',
    'a(b)@example.com',
    'a[b]@example.com',
    'a@b@example.com',
    'a\u0000@example.com',
    'a\u007f@example.com',
    'a@example',
    'a@.com',
    'a@example.',
    'a@example..com',
    '@example.com',
    'a@',
  ])('refuses %j', (email) => {
    expect(EMAIL_RE.test(email)).toBe(false)
  })

  // Addresses stored before the rule was tightened still find their account
  it('the account lookup rule still takes older addresses, but no control characters', () => {
    expect(ACCOUNT_EMAIL_RE.test('x"@example.com')).toBe(true)
    expect(ACCOUNT_EMAIL_RE.test('a\u0000@example.com')).toBe(false)
  })
})
