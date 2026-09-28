import { describe, expect, it } from 'vitest'
import { scrubUrl } from './insightsUrl'

const APP = 'https://app.example.com'

describe('scrubUrl', () => {
  it('keeps ordinary addresses', () => {
    expect(scrubUrl(`${APP}/`)).toBe(`${APP}/`)
    expect(scrubUrl(`${APP}/docs/publishing`)).toBe(`${APP}/docs/publishing`)
    expect(scrubUrl(`${APP}/legal/privacy`)).toBe(`${APP}/legal/privacy`)
  })

  it('drops query strings and fragments, which carry sign-in tokens and consent requests', () => {
    expect(scrubUrl(`${APP}/auth/confirm?token=abc123&next=%2Fapp`)).toBe(`${APP}/auth/confirm`)
    expect(scrubUrl(`${APP}/authorize?request=req_1`)).toBe(`${APP}/authorize`)
    expect(scrubUrl(`${APP}/login?next=%2Fauthorize%3Frequest%3Dreq_1`)).toBe(`${APP}/login`)
    expect(scrubUrl(`${APP}/settings#security`)).toBe(`${APP}/settings`)
  })

  it('replaces invitation tokens and page slugs in the path', () => {
    expect(scrubUrl(`${APP}/invite/s3cr3t-token`)).toBe(`${APP}/invite/[token]`)
    expect(scrubUrl(`${APP}/a/k2j4h5`)).toBe(`${APP}/a/[page]`)
    expect(scrubUrl(`${APP}/a/k2j4h5?comments`)).toBe(`${APP}/a/[page]`)
  })

  it('sends nothing usable for an address it cannot read', () => {
    expect(scrubUrl('not a url')).toBe('')
  })
})
