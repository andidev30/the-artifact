import { describe, expect, it } from 'vitest'
import { sameOriginPath } from '../../src/auth/next.js'

// The same table is in apps/web/src/next.test.ts
const APP = 'https://app.example.com'

// Paths people go back to after signing in
const KEPT: [string, string][] = [
  ['/app', '/app'],
  ['/authorize?request=abc', '/authorize?request=abc'],
  ['/settings#security', '/settings#security'],
  ['/a/xyz?k=1&x=2', '/a/xyz?k=1&x=2'],
  ['/invite/tok%2Den', '/invite/tok%2Den'],
  ['/docs/../app', '/app'],
]

// Anything that could end on another site, or is not a path
const REFUSED: unknown[] = [
  null,
  undefined,
  '',
  42,
  'app',
  ' /app',
  'javascript:alert(1)',
  'https://evil.example/',
  'http://app.example.com/app',
  '//evil.example',
  '///evil.example',
  '/\\evil.example',
  '/\\/evil.example',
  '\\\\evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r/evil.example',
  '/\t\\evil.example',
  '/\u0000/evil.example',
  '/\u007f/evil.example',
  '/%2F/evil.example',
  '/%2f%2fevil.example',
  '/%5Cevil.example',
  '/%5c/evil.example',
  '/%09/evil.example',
  '/%0a/evil.example',
  '/%E0%A4%A',
  '/..//evil.example',
  '/./%2e%2e//evil.example',
  `/${'a'.repeat(2001)}`,
]

describe('sameOriginPath', () => {
  it.each(KEPT)('keeps %j', (next, path) => {
    expect(sameOriginPath(next, APP)).toBe(path)
  })

  it.each(REFUSED.map((next) => [next]))('refuses %j', (next) => {
    expect(sameOriginPath(next, APP)).toBeNull()
  })
})
