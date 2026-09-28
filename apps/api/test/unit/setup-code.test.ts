import { describe, expect, it } from 'vitest'
import { normalizeSetupCode, setupCodeSetting } from '../../src/env.js'
import { newSetupCode } from '../../src/setup-code.js'

describe('setup codes', () => {
  it('are three groups of four characters that are easy to read', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newSetupCode()))
    expect(codes.size).toBe(50)
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
  })

  it('are compared without case, spaces or dashes', () => {
    expect(normalizeSetupCode(' abcd-efgh jkmn ')).toBe('ABCDEFGHJKMN')
    expect(normalizeSetupCode(undefined)).toBe('')
    expect(normalizeSetupCode(42)).toBe('')
  })

  it('reads SETUP_CODE when it is long enough', () => {
    expect(setupCodeSetting(undefined)).toBeNull()
    expect(setupCodeSetting('  ')).toBeNull()
    expect(setupCodeSetting('my-install-code-2026')).toBe('MYINSTALLCODE2026')
    expect(() => setupCodeSetting('short-1234')).toThrow(/at least 12/)
  })
})
