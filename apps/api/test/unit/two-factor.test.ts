import { describe, expect, it } from 'vitest'
import { describeDevice } from '../../src/auth/devices.js'
import { base32Decode, base32Encode, currentStep, matchTotp, otpauthUrl, totpCode } from '../../src/auth/totp.js'
import { newRecoveryCodes } from '../../src/auth/twofactor.js'

// RFC 6238 appendix B, SHA-1, with the last six of its eight digits
const RFC_SECRET = Buffer.from('12345678901234567890')
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
]

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, code] of VECTORS) expect(totpCode(RFC_SECRET, currentStep(seconds * 1000))).toBe(code)
  })

  it('base32 round-trips, ignoring spaces and case', () => {
    const bytes = Buffer.from('12345678901234567890')
    const text = base32Encode(bytes)
    expect(text).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(bytes)
    expect(() => base32Decode('not base32!')).toThrow()
  })

  it('accepts one step either side and nothing at or before the last used step', () => {
    const now = 1234567890 * 1000
    const step = currentStep(now)
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), 0, now)).toBe(step)
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), 0, now)).toBe(step - 1)
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), 0, now)).toBe(step + 1)
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), 0, now)).toBeNull()
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), step, now)).toBeNull()
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), step, now)).toBe(step + 1)
    expect(matchTotp(RFC_SECRET, '12345', 0, now)).toBeNull()
    expect(matchTotp(RFC_SECRET, 'abcdef', 0, now)).toBeNull()
  })

  it('writes the otpauth link authenticator apps read', () => {
    expect(otpauthUrl(RFC_SECRET, 'The Artifact', 'pat@example.com')).toBe(
      'otpauth://totp/The%20Artifact:pat%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=The+Artifact&algorithm=SHA1&digits=6&period=30',
    )
  })
})

describe('recovery codes', () => {
  it('are ten readable codes without look-alike characters', () => {
    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(10)
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/)
  })
})

describe('describeDevice', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome', 'macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox', 'Linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome', 'Android'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
  ])('%s', (ua, browser, os) => {
    expect(describeDevice(ua)).toEqual({ browser, os })
  })

  it('knows nothing without a user agent', () => {
    expect(describeDevice(null)).toEqual({ browser: null, os: null })
    expect(describeDevice('curl/8.0')).toEqual({ browser: null, os: null })
  })
})
