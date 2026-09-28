import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Rewrite = { source: string; destination: string }
const config = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8')) as { rewrites: Rewrite[] }

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
})
