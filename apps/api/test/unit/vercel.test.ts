import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHELL_HEADERS } from '../../src/previews.js'

type Rewrite = { source: string; destination: string }
type Headers = { source: string; headers: { key: string; value: string }[] }
const config = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8')) as { rewrites: Rewrite[]; headers: Headers[] }
const robots = readFileSync(new URL('../../../web/public/robots.txt', import.meta.url), 'utf8')

// Vercel's `:name*` never matches a trailing slash, and page content is served under addresses that
// end in one (/api/artifacts/<slug>/v/<n>/), so such a request fell through to the web app's
// index.html and every page showed "This page doesn't exist" on the hosted service
describe('vercel.json', () => {
  it('uses (.*) instead of :name* for the API rewrites', () => {
    const api = config.rewrites.filter((r) => r.destination === '/api')
    expect(api.map((r) => r.source).filter((s) => /:\w+\*/.test(s))).toEqual([])
  })

  it.each(['/api/artifacts/k3v9x2m8pq/v/1/', '/api/artifacts/k3v9x2m8pq/v/1/~token/img/a.png', '/mcp/', '/oauth/token', '/scim/v2/Users'])(
    'sends %s to the API before the web app',
    (path) => {
      const first = config.rewrites.find((r) => new RegExp(`^${r.source.replace(/:\w+(?!\*)/g, '[^/]+')}$`).test(path))
      expect(first?.destination).toBe('/api')
    },
  )

  // The static app shell and assets never pass through the API, which sets it for its own responses
  it('sends nosniff on every path', () => {
    const all = config.headers.find((h) => h.source === '/(.*)')
    expect(all?.headers).toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' })
  })

  it('gives the static app shell the same framing and CSP as the API does', () => {
    const shell = config.headers.find((h) => h.source === '/((?!api/|e/).*)')
    expect(shell?.headers).toContainEqual({ key: 'Content-Security-Policy', value: SHELL_HEADERS['Content-Security-Policy'] })
    expect(shell?.headers).toContainEqual({ key: 'X-Frame-Options', value: SHELL_HEADERS['X-Frame-Options'] })
  })

  // Served as a static file ahead of the app shell rewrite
  it('keeps crawlers off pages, embeds and the API', () => {
    const everyone = robots.split(/\n\s*\n/).find((group) => /^User-agent: \*$/m.test(group))
    for (const path of ['/api/', '/a/', '/e/']) expect(everyone).toContain(`Disallow: ${path}`)
    expect(everyone).toContain('Allow: /')
  })
})
