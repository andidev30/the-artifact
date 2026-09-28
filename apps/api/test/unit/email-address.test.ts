import { describe, expect, it } from 'vitest'
import { isAccountEmail, isEmail } from '../../src/validation.js'

describe('isEmail', () => {
  it.each(['ana@example.com', 'ana.lee+pages@mail.example.co.uk', 'o_brien-2@sub.example.io', 'renée@exemple.fr', "o'neil@example.com"])(
    'accepts %s',
    (email) => {
      expect(isEmail(email)).toBe(true)
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
    expect(isEmail(email)).toBe(false)
  })

  // Addresses stored before the rule was tightened still find their account
  it('the account lookup rule still takes older addresses, but no control characters', () => {
    expect(isAccountEmail('x"@example.com')).toBe(true)
    expect(isAccountEmail('a\u0000@example.com')).toBe(false)
  })

  it('refuses addresses longer than 254 characters', () => {
    const at254 = `${'a'.repeat(64)}@${'b'.repeat(185)}.com`
    expect(at254).toHaveLength(254)
    expect(isEmail(at254)).toBe(true)
    expect(isAccountEmail(at254)).toBe(true)
    expect(isEmail(`a${at254}`)).toBe(false)
    expect(isAccountEmail(`a${at254}`)).toBe(false)
  })
})

// The pattern the account lookup rule had before it was rewritten to run in linear time
const OLD_ACCOUNT_EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u

describe('isAccountEmail', () => {
  it.each([
    'ana@example.com',
    'x"@example.com',
    'a<b>@example.com',
    'a,b;c@example.com',
    'a@b.c',
    'a@..c',
    'a@b..',
    'a@b.c.',
    'a@.b.c',
    '.a.@x.y.z',
    'renée@exemple.fr',
  ])('accepts %j, as it always has', (email) => {
    expect(OLD_ACCOUNT_EMAIL_RE.test(email)).toBe(true)
    expect(isAccountEmail(email)).toBe(true)
  })

  it.each([
    'a@example',
    'a@.com',
    'a@example.',
    'a@.',
    'a@b.',
    '@example.com',
    'a@',
    'a b@example.com',
    'a@b@example.com',
    'a@exam ple.com',
    'a\u007f@example.com',
  ])('refuses %j, as it always has', (email) => {
    expect(OLD_ACCOUNT_EMAIL_RE.test(email)).toBe(false)
    expect(isAccountEmail(email)).toBe(false)
  })

  it('decides every short address the way the old pattern did', () => {
    const letters = ['a', '.', '@', ' ', '"', '\u0000']
    const check = (s: string) => {
      expect(isAccountEmail(s), JSON.stringify(s)).toBe(OLD_ACCOUNT_EMAIL_RE.test(s))
      if (s.length < 7) for (const l of letters) check(s + l)
    }
    check('')
  })
})

describe('checking an address', () => {
  // Input an unbounded or backtracking pattern takes seconds on, sent to sign-in without an account
  it.each([
    ['dots', `a@${'.'.repeat(1024 * 1024)}@`],
    ['labels', `a@${'b.'.repeat(512 * 1024)}@`],
    ['a long local part', `${'a'.repeat(1024 * 1024)}@`],
  ])('is quick on 1 MB of %s', (_, input) => {
    for (const check of [isEmail, isAccountEmail]) {
      const started = performance.now()
      expect(check(input)).toBe(false)
      expect(performance.now() - started).toBeLessThan(50)
    }
  })
})
