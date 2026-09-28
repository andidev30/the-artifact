import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { contentCsp, contentHost } from '../../src/content.js'
import { env } from '../../src/env.js'
import { mountWeb, SELF_HOSTED_ROBOTS } from '../../src/web.js'
import { call, createPage, createUser } from './helpers.js'

const HOSTED_ROBOTS = 'User-agent: *\nDisallow: /api/\n'

// The built web app served next to the API, as in the Docker image
const site = new Hono()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-web-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>The Artifact</title><div id="root"></div>')
  writeFileSync(join(dir, 'robots.txt'), HOSTED_ROBOTS)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'assets', 'font-abc123.woff2'), 'wOF2')
  mountWeb(site, dir)
})

const original = { selfHosted: env.selfHosted, appUrl: env.appUrl }
afterEach(() => {
  env.selfHosted = original.selfHosted
  env.appUrl = original.appUrl
  delete process.env.VERCEL
})

describe('X-Content-Type-Options', () => {
  it('is nosniff on API, OAuth, health and embed responses, errors and redirects included', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    for (const [path, status] of [
      ['/api/config', 200],
      ['/api/me', 401],
      ['/api/artifacts/nosuchpage', 404],
      [`/api/artifacts/${page.slug}`, 200],
      ['/api/no/such/route', 404],
      ['/healthz', 200],
      ['/readyz', 200],
      ['/.well-known/oauth-authorization-server', 200],
      ['/oauth/authorize', 302],
      [`/api/oembed?url=${encodeURIComponent(`${env.appUrl}/a/${page.slug}`)}`, 200],
      [`/e/${page.slug}`, 200],
      [`/api/artifacts/${page.slug}/v/1/`, 200],
    ] as const) {
      const res = await call(path)
      expect(res.status, path).toBe(status)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
    }
    const post = await call('/api/auth/password/login', { json: {} })
    expect(post.status).toBe(400)
    expect(post.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('is nosniff on the app shell and its build files', async () => {
    for (const path of ['/', '/docs/introduction', '/assets/index-abc123.js', '/assets/font-abc123.woff2', '/robots.txt', '/assets/missing.js']) {
      const res = await site.request(path)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
    }
    expect((await site.request('/assets/index-abc123.js')).headers.get('content-type')).toContain('javascript')
    expect((await site.request('/assets/font-abc123.woff2')).headers.get('content-type')).toBe('font/woff2')
  })
})

describe('Strict-Transport-Security', () => {
  it('is sent with an https APP_URL, on the API, page content and the app shell', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    env.appUrl = 'https://artifact.example.com'
    for (const path of ['/api/config', '/api/me', '/healthz', `/e/${page.slug}`, `/api/artifacts/${page.slug}/v/1/`]) {
      expect((await call(path)).headers.get('strict-transport-security'), path).toBe('max-age=31536000')
    }
    for (const path of ['/', '/assets/index-abc123.js', '/robots.txt']) {
      expect((await site.request(path)).headers.get('strict-transport-security'), path).toBe('max-age=31536000')
    }
  })

  it('is not sent over plain http, or on Vercel, which sends its own', async () => {
    expect((await call('/api/config')).headers.get('strict-transport-security')).toBeNull()
    expect((await site.request('/')).headers.get('strict-transport-security')).toBeNull()
    env.appUrl = 'https://artifact.example.com'
    process.env.VERCEL = '1'
    expect((await call('/api/config')).headers.get('strict-transport-security')).toBeNull()
  })
})

describe('Content-Security-Policy', () => {
  it('keeps plugins and <base> out of the app shell, and leaves page content its own policy', async () => {
    for (const path of ['/', '/app', '/docs/introduction']) {
      expect((await site.request(path)).headers.get('content-security-policy'), path).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
    }
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const content = await call(`/api/artifacts/${page.slug}/v/1/`, { headers: { 'sec-fetch-dest': 'iframe' } })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-security-policy')).toBe(contentCsp())
    expect(content.headers.get('content-security-policy')).not.toContain('object-src')
  })
})

describe('the web app', () => {
  it('answers only GET and HEAD with the shell and its files', async () => {
    expect((await site.request('/')).status).toBe(200)
    expect((await site.request('/', { method: 'HEAD' })).status).toBe(200)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const path of ['/', '/index.html', '/some/unknown/page', '/a/k3v9x2m8pq']) {
        const res = await site.request(path, { method })
        expect(res.status, `${method} ${path}`).toBe(405)
        expect(res.headers.get('allow')).toBe('GET, HEAD')
        expect(await res.text()).not.toContain('<div id="root">')
      }
      expect((await site.request('/assets/index-abc123.js', { method })).status).toBe(404)
      expect((await site.request('/api/nothing', { method })).status).toBe(404)
    }
  })

  it('serves robots.txt from the build on the hosted service', async () => {
    env.selfHosted = false
    const res = await site.request('/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe(HOSTED_ROBOTS)
  })

  it('keeps crawlers off a self-hosted install, except for link previews', async () => {
    env.selfHosted = true
    const res = await site.request('/robots.txt')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe(SELF_HOSTED_ROBOTS)
    expect(text.split('\n\n')[0]).toBe('User-agent: *\nDisallow: /')
    expect(text).toContain('User-agent: Slackbot-LinkExpanding')
    expect(text).toContain('Allow: /a/')
  })

  it('the content host asks crawlers to stay away', async () => {
    const res = await contentHost.request('/robots.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n')
  })
})
