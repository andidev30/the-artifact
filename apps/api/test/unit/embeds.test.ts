import { describe, expect, it } from 'vitest'
import { contentOrigin, embedFrameAncestors } from '../../src/env.js'

describe('CONTENT_ORIGIN', () => {
  const app = 'https://artifact.example.com'

  it('is off when unset', () => {
    expect(contentOrigin(undefined, app)).toBeNull()
    expect(contentOrigin(' ', app)).toBeNull()
  })

  it('takes an origin, with or without a trailing slash', () => {
    expect(contentOrigin('https://content.example.net', app)).toBe('https://content.example.net')
    expect(contentOrigin('https://Content.example.net:8443/', app)).toBe('https://content.example.net:8443')
    expect(contentOrigin('http://127.0.0.1:3004', 'http://localhost:5177')).toBe('http://127.0.0.1:3004')
  })

  it('refuses a path, credentials, other schemes and anything that could change a header', () => {
    for (const value of [
      'content.example.net',
      'https://content.example.net/pages',
      'https://content.example.net/?a=1',
      'https://user:pass@content.example.net',
      'ftp://content.example.net',
      "https://a;script-src 'unsafe-inline'.example.net",
      'javascript:alert(1)',
    ]) {
      expect(() => contentOrigin(value, app), value).toThrow(/CONTENT_ORIGIN must be an origin/)
    }
  })

  it('refuses the app host, on any port, since cookies ignore the port', () => {
    expect(() => contentOrigin('https://artifact.example.com:8443', app)).toThrow(/another host than APP_URL/)
  })
})

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
