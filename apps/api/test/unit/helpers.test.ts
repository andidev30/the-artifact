import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseArtifactRef } from '../../src/artifacts.js'
import { hashToken, randomToken } from '../../src/auth/session.js'
import { afterSignInUrl, safeNext } from '../../src/auth/users.js'
import { isAllowedRedirect, pkceMatches, redirectMatches } from '../../src/oauth/server.js'
import { slugProblem } from '../../src/routes/organizations.js'
import { parseEmails } from '../../src/sharing.js'

describe('safeNext', () => {
  it.each(['/app', '/a/abc123', '/authorize?request=x', '/'])('keeps same-site path %s', (path) => {
    expect(safeNext(path)).toBe(path)
  })

  it.each([
    ['protocol-relative', '//evil.com'],
    ['backslash trick', '/\\evil.com'],
    ['absolute URL', 'https://evil.com/app'],
    ['relative path', 'app'],
    ['javascript URL', 'javascript:alert(1)'],
    ['empty', ''],
  ])('rejects %s', (_, path) => {
    expect(safeNext(path)).toBeNull()
  })

  it('rejects null and undefined', () => {
    expect(safeNext(null)).toBeNull()
    expect(safeNext(undefined)).toBeNull()
  })
})

describe('afterSignInUrl', () => {
  it('goes to the gallery by default', () => {
    expect(afterSignInUrl(null)).toBe('http://localhost:5177/app')
  })

  it('carries a known plan', () => {
    expect(afterSignInUrl('organization')).toBe('http://localhost:5177/app?plan=organization')
  })

  it('drops unknown plans', () => {
    expect(afterSignInUrl('enterprise')).toBe('http://localhost:5177/app')
  })

  it('prefers a safe next path and ignores unsafe ones', () => {
    expect(afterSignInUrl('organization', '/a/xyz')).toBe('http://localhost:5177/a/xyz')
    expect(afterSignInUrl(null, '//evil.com')).toBe('http://localhost:5177/app')
  })
})

describe('parseArtifactRef', () => {
  it('returns a bare slug unchanged', () => {
    expect(parseArtifactRef('abc234xyz')).toBe('abc234xyz')
  })

  it('trims whitespace', () => {
    expect(parseArtifactRef('  abc234  ')).toBe('abc234')
  })

  it.each(['http://localhost:5177/a/abc234', 'https://the-artifact.example/a/abc234/', '/a/abc234'])('extracts the slug from %s', (link) => {
    expect(parseArtifactRef(link)).toBe('abc234')
  })
})

describe('slugProblem', () => {
  it.each(['acme', 'a1b', 'acme-inc', 'x'.repeat(40), '123'])('accepts %s', (slug) => {
    expect(slugProblem(slug)).toBeNull()
  })

  it.each([
    ['too short', 'ab'],
    ['too long', 'x'.repeat(41)],
    ['uppercase', 'Acme'],
    ['leading hyphen', '-acme'],
    ['trailing hyphen', 'acme-'],
    ['underscore', 'acme_inc'],
    ['space', 'acme inc'],
    ['empty', ''],
  ])('rejects %s', (_, slug) => {
    expect(slugProblem(slug)).toMatch(/3 to 40/)
  })

  it.each(['api', 'app', 'login', 'signup', 'admin', 'mcp', 'onboarding'])('rejects reserved %s', (slug) => {
    expect(slugProblem(slug)).toMatch(/reserved/)
  })
})

describe('isAllowedRedirect', () => {
  it.each([
    'https://client.example.com/callback',
    'http://localhost:33418/callback',
    'http://127.0.0.1/cb',
    'http://[::1]:8080/cb',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
    'vscode://ms.mcp/callback',
  ])('allows %s', (uri) => {
    expect(isAllowedRedirect(uri)).toBe(true)
  })

  it.each([
    ['plain http to a remote host', 'http://client.example.com/callback'],
    ['http to a lookalike host', 'http://localhost.evil.com/cb'],
    ['a fragment', 'https://client.example.com/cb#frag'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['file', 'file:///etc/passwd'],
    ['not a URL', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_, uri) => {
    expect(isAllowedRedirect(uri)).toBe(false)
  })
})

describe('redirectMatches', () => {
  const registered = ['http://127.0.0.1:4000/callback', 'https://client.example.com/cb', 'cursor://x/cb']

  it('matches an exact registered URI', () => {
    expect(redirectMatches(registered, 'https://client.example.com/cb')).toBe(true)
    expect(redirectMatches(registered, 'cursor://x/cb')).toBe(true)
  })

  it('lets loopback clients use another port on the same host and path', () => {
    expect(redirectMatches(registered, 'http://127.0.0.1:59123/callback')).toBe(true)
  })

  it('rejects loopback with another path or host', () => {
    expect(redirectMatches(registered, 'http://127.0.0.1:59123/other')).toBe(false)
    expect(redirectMatches(registered, 'http://localhost:4000/callback')).toBe(false)
  })

  it('does not relax matching for non-loopback URIs', () => {
    expect(redirectMatches(registered, 'https://client.example.com/cb2')).toBe(false)
    expect(redirectMatches(registered, 'https://client.example.com:8443/cb')).toBe(false)
    expect(redirectMatches(registered, 'https://evil.example.com/cb')).toBe(false)
  })

  it('rejects garbage', () => {
    expect(redirectMatches(registered, 'nope')).toBe(false)
  })
})

describe('pkceMatches', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

  it('accepts the RFC 7636 appendix B example', () => {
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true)
  })

  it('accepts any verifier against its own S256 challenge', () => {
    const v = randomToken()
    expect(pkceMatches(v, createHash('sha256').update(v).digest('base64url'))).toBe(true)
  })

  it('rejects a different verifier or a plain challenge', () => {
    expect(pkceMatches('wrong', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false)
    expect(pkceMatches(verifier, verifier)).toBe(false)
  })
})

describe('tokens', () => {
  it('makes distinct url-safe random tokens', () => {
    const a = randomToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(a)
  })

  it('hashes deterministically as hex SHA-256', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('parseEmails', () => {
  it('splits a string on commas, semicolons and whitespace', () => {
    expect(parseEmails('a@x.com, b@x.com;c@x.com\nd@x.com  e@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'])
  })

  it('lowercases, trims and removes duplicates', () => {
    expect(parseEmails(['  A@X.com ', 'a@x.com', 'B@x.com'])).toEqual(['a@x.com', 'b@x.com'])
  })

  it('ignores non-strings and blanks', () => {
    expect(parseEmails(['a@x.com', 42, null, '', '   '])).toEqual(['a@x.com'])
  })

  it('returns nothing for other input', () => {
    expect(parseEmails(undefined)).toEqual([])
    expect(parseEmails({ email: 'a@x.com' })).toEqual([])
    expect(parseEmails('')).toEqual([])
  })

  it('keeps invalid addresses for the caller to reject', () => {
    expect(parseEmails('not-an-email')).toEqual(['not-an-email'])
  })
})
