import type { Context } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { env, parseSize, thumbnailConcurrency } from '../../src/env.js'
import { clientIp, normalizeIp, parseRateLimits, waitText, windowText } from '../../src/limits.js'

describe('RATE_LIMITS', () => {
  it('keeps the defaults when empty', () => {
    const rules = parseRateLimits('')
    expect(rules.get('sign-in-link')).toEqual({ max: 10, seconds: 3600 })
    expect(rules.get('mcp')).toEqual({ max: 600, seconds: 600 })
  })

  it('turns every limit off', () => {
    for (const value of ['off', 'OFF', 'false', '0']) expect([...parseRateLimits(value).values()].every((r) => r === null)).toBe(true)
  })

  it('changes or turns off single limits', () => {
    const rules = parseRateLimits('sign-in-link=20/1h, mcp=1000/10m,publish=off,password=5/m, invite=50/2d')
    expect(rules.get('sign-in-link')).toEqual({ max: 20, seconds: 3600 })
    expect(rules.get('mcp')).toEqual({ max: 1000, seconds: 600 })
    expect(rules.get('publish')).toBeNull()
    expect(rules.get('password')).toEqual({ max: 5, seconds: 60 })
    expect(rules.get('invite')).toEqual({ max: 50, seconds: 2 * 86400 })
    expect(rules.get('oauth-register-ip')).toEqual({ max: 60, seconds: 3600 })
  })

  it('refuses names and values it does not know', () => {
    expect(() => parseRateLimits('signin=5/1h')).toThrow(/no limit called "signin"/)
    expect(() => parseRateLimits('mcp=lots')).toThrow(/like mcp=20\/1h/)
    expect(() => parseRateLimits('mcp=0/1h')).toThrow(/like mcp=20\/1h/)
    expect(() => parseRateLimits('mcp=5/1w')).toThrow(/like mcp=20\/1h/)
  })
})

describe('sizes', () => {
  it('reads sizes in powers of 1024', () => {
    expect(parseSize('500MB', 'X')).toBe(500 * 1024 ** 2)
    expect(parseSize('1.5 gb', 'X')).toBe(1.5 * 1024 ** 3)
    expect(parseSize('2048', 'X')).toBe(2048)
    expect(parseSize('', 'X')).toBeNull()
    expect(() => parseSize('lots', 'WORKSPACE_MAX_STORAGE')).toThrow(/WORKSPACE_MAX_STORAGE must be a size/)
  })
})

describe('THUMBNAIL_CONCURRENCY', () => {
  it('is 2 unless set, and 1 to 8', () => {
    expect(thumbnailConcurrency(undefined)).toBe(2)
    expect(thumbnailConcurrency(' ')).toBe(2)
    expect(thumbnailConcurrency('1')).toBe(1)
    expect(thumbnailConcurrency(' 8 ')).toBe(8)
    for (const value of ['0', '9', '2.5', '-1', 'two'])
      expect(() => thumbnailConcurrency(value), value).toThrow(/THUMBNAIL_CONCURRENCY must be a whole number from 1 to 8/)
  })
})

describe('messages', () => {
  it('says how long to wait', () => {
    expect(waitText(1)).toBe('1 second')
    expect(waitText(45)).toBe('45 seconds')
    expect(waitText(61)).toBe('2 minutes')
    expect(waitText(3600)).toBe('60 minutes')
    expect(waitText(3 * 3600)).toBe('3 hours')
  })

  it('names the window', () => {
    expect(windowText(3600)).toBe('hour')
    expect(windowText(600)).toBe('10 minutes')
    expect(windowText(86400)).toBe('day')
    expect(windowText(90)).toBe('90 seconds')
  })
})

describe('client address', () => {
  const trust = env.trustProxy
  afterEach(() => {
    env.trustProxy = trust
  })

  function context(forwardedFor: string | undefined, remoteAddress?: string) {
    return {
      req: { header: (name: string) => (name === 'x-forwarded-for' ? forwardedFor : undefined) },
      env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
    } as unknown as Context
  }

  it('uses the connection and ignores X-Forwarded-For unless told there is a proxy', () => {
    env.trustProxy = 0
    expect(clientIp(context('203.0.113.9', '::ffff:10.0.0.2'))).toBe('10.0.0.2')
    expect(clientIp(context('203.0.113.9'))).toBeNull()
  })

  it('takes the address the trusted proxies saw, not what the client wrote before them', () => {
    env.trustProxy = 1
    expect(clientIp(context('1.1.1.1, 203.0.113.9', '10.0.0.2'))).toBe('203.0.113.9')
    env.trustProxy = 2
    expect(clientIp(context('1.1.1.1, 203.0.113.9, 10.0.0.5', '10.0.0.2'))).toBe('203.0.113.9')
    env.trustProxy = 1
    expect(clientIp(context(undefined, '10.0.0.2'))).toBe('10.0.0.2')
  })

  it('counts an IPv6 address by its /64', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(normalizeIp('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64')
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64')
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1')
  })
})
