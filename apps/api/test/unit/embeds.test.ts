import { describe, expect, it } from 'vitest'
import { embedFrameAncestors } from '../../src/env.js'

describe('EMBED_FRAME_ANCESTORS', () => {
  it('lets anyone frame embeds when unset or *', () => {
    expect(embedFrameAncestors(undefined)).toBeNull()
    expect(embedFrameAncestors('')).toBeNull()
    expect(embedFrameAncestors(' * ')).toBeNull()
  })

  it('none keeps them to this app', () => {
    expect(embedFrameAncestors('none')).toBe("'self'")
  })

  it('takes origins separated by spaces or commas', () => {
    expect(embedFrameAncestors('https://www.notion.so, https://*.atlassian.net  http://wiki.local:8080')).toBe(
      "'self' https://www.notion.so https://*.atlassian.net http://wiki.local:8080",
    )
  })

  it('refuses anything that could change the header', () => {
    for (const value of [
      "https://a.example; script-src 'unsafe-inline'",
      'www.notion.so',
      'https://a.example/path',
      "'unsafe-inline'",
      'javascript:alert(1)',
    ]) {
      expect(() => embedFrameAncestors(value), value).toThrow(/EMBED_FRAME_ANCESTORS/)
    }
  })
})
