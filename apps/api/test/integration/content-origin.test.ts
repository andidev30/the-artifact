import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { publish } from '../../src/artifacts.js'
import { contentCsp } from '../../src/content.js'
import { env } from '../../src/env.js'
import { forgetRecentViews, totalViews } from '../../src/views.js'
import { mountWeb } from '../../src/web.js'
import { call, createPage, createUser, registerClient, type TestUser } from './helpers.js'

const CONTENT = 'http://content.test'
const INDEX = '<!doctype html><html><head><title>The Artifact</title></head><body><div id="root"></div></body></html>'

// The API with the built web app behind it, as in the Docker image
const site = new Hono()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-web-'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  site.route('/', app)
  mountWeb(site, dir)
})

const saved = { contentOrigin: env.contentOrigin, trustProxy: env.trustProxy, embedFrameAncestors: env.embedFrameAncestors }
beforeEach(() => {
  env.contentOrigin = CONTENT
  forgetRecentViews()
})
afterEach(() => {
  Object.assign(env, saved)
})

// A request to the content host, as a sandboxed frame's navigation unless told otherwise
function onContent(path: string, opts: { cookie?: string; dest?: string; method?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { 'sec-fetch-dest': opts.dest ?? 'iframe' }
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return site.request(`${CONTENT}${path}`, { method: opts.method ?? 'GET', headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) })
}

// The sandboxed frame's navigation on the app's host
function frame(path: string, cookie?: string) {
  return call(path, { cookie, headers: { 'sec-fetch-dest': 'iframe' } })
}

function patch(slug: string, user: TestUser, json: Record<string, unknown>) {
  return call(`/api/artifacts/${slug}`, { method: 'PATCH', cookie: user.cookie, json })
}

function pageLinkCookie(res: Response) {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith('page_link='))!
    .split(';')[0]
}

// Follows a redirect to the content host and checks what it serves there
async function contentAt(location: string, opts: { dest?: string } = {}) {
  expect(location.startsWith(`${CONTENT}/`)).toBe(true)
  const res = await onContent(location.slice(CONTENT.length), opts)
  expect(res.headers.getSetCookie()).toEqual([])
  return res
}

describe('with CONTENT_ORIGIN', () => {
  it('sends a link-shared page to the content host, which serves it without cookies', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Signups', visibility: 'link', html: '<h1>Signups</h1>' })
    const base = `/api/artifacts/${page.slug}/v/1/`

    const nav = await frame(base)
    expect(nav.status).toBe(302)
    expect(nav.headers.get('location')).toBe(`${CONTENT}${base}`)
    expect(nav.headers.get('cache-control')).toBe('no-store')

    const res = await contentAt(nav.headers.get('location')!)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>Signups</h1>')
    expect(res.headers.get('content-security-policy')).toBe(contentCsp())
    expect(res.headers.get('vary')).toBeNull()
    expect(await totalViews(page)).toBe(1)

    // Subresource requests and people's own cookies change nothing there
    expect((await onContent(base, { dest: 'script', cookie: owner.cookie })).status).toBe(200)
    // Not even the app's own requests are served on its host
    expect((await call(base)).status).toBe(302)
    expect((await call(`/api/artifacts/${page.slug}/v/1`)).status).toBe(301)
    expect((await onContent(`/api/artifacts/${page.slug}/v/1`)).headers.get('location')).toBe(base)
  })

  it('carries a signed-in viewer to the content host with a link token, and ignores the session cookie there', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const page = await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: null,
      clientName: 'test-client',
      title: 'Site',
      html: '<link rel="stylesheet" href="site.css"><h1>Private</h1>',
      files: [{ path: 'site.css', content: 'h1 { color: red }' }],
    })
    const base = `/api/artifacts/${page.slug}/v/1/`

    // The session cookie reaches the content host only if something sends it by hand; it opens nothing
    expect((await onContent(base, { cookie: owner.cookie })).status).toBe(404)
    expect((await frame(base)).status).toBe(404)
    expect((await frame(base, stranger.cookie)).status).toBe(404)

    const nav = await frame(base, owner.cookie)
    expect(nav.status).toBe(302)
    const location = nav.headers.get('location')!
    expect(location).toMatch(new RegExp(`^${CONTENT}${base}~[0-9a-f]{32}\\.[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`))
    const res = await contentAt(location)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<h1>Private</h1>')
    const css = await contentAt(`${location}site.css`, { dest: 'style' })
    expect(css.status).toBe(200)
    expect(await css.text()).toBe('h1 { color: red }')

    // A token URL asked for on the app's host goes to the content host too
    const again = await call(`${location.slice(CONTENT.length)}site.css`)
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe(`${location}site.css`)

    // A forged token opens nothing on either host
    const forged = `${base}~${'0'.repeat(32)}.zzzz.${'a'.repeat(32)}/`
    expect((await onContent(forged)).status).toBe(404)
    expect((await call(forged)).status).toBe(404)
  })

  it('carries a link password to the content host as a grant in the path, never the cookie', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Board deck', visibility: 'link', html: '<h1>Numbers</h1>' })
    expect((await patch(page.slug, owner, { linkPassword: 'correct horse' })).status).toBe(200)
    const base = `/api/artifacts/${page.slug}/v/1/`

    expect((await frame(base)).status).toBe(404)
    expect((await onContent(base)).status).toBe(404)

    const unlocked = await call(`/api/artifacts/${page.slug}/unlock`, { json: { password: 'correct horse' } })
    expect(unlocked.status).toBe(204)
    const cookie = pageLinkCookie(unlocked)

    // The grant cookie is for the app's host; sent to the content host it is ignored
    expect((await onContent(base, { cookie })).status).toBe(404)

    const nav = await frame(base, cookie)
    expect(nav.status).toBe(302)
    const location = nav.headers.get('location')!
    expect(location).toMatch(new RegExp(`^${CONTENT}${base}~[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`))
    const res = await contentAt(location)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>Numbers</h1>')

    // A new password locks out the grant on the content host as well
    await patch(page.slug, owner, { linkPassword: 'battery staple' })
    expect((await onContent(location.slice(CONTENT.length))).status).toBe(404)
  })

  it('takes a reset link key on the content host itself, and embeds frame the content host', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Roadmap', visibility: 'link', html: '<h1>Plans</h1>' })
    const key = new URL((await (await patch(page.slug, owner, { rotateLink: true })).json()).link.url).searchParams.get('k')!
    const base = `/api/artifacts/${page.slug}/v/1/`

    expect((await onContent(base)).status).toBe(404)
    expect((await onContent(`${base}?k=wrong`)).status).toBe(404)
    const nav = await onContent(`${base}?k=${key}`)
    expect(nav.status).toBe(302)
    // Stays on the content host, with a grant rather than a cookie
    const location = nav.headers.get('location')!
    expect(location).toMatch(new RegExp(`^${base}~[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`))
    expect(nav.headers.getSetCookie()).toEqual([])
    expect((await onContent(location)).status).toBe(200)

    // The embed document stays on the app's host and frames the content host directly
    const embed = await site.request(`/e/${page.slug}?k=${key}`)
    expect(embed.status).toBe(200)
    expect(await embed.text()).toContain(`src="${CONTENT}${base}?k=${key}"`)
    expect(embed.headers.get('content-security-policy')).toContain(`frame-src 'self' ${CONTENT};`)
  })

  it('refuses everything else on the content host, so it can never act as the app', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const client = await registerClient()
    const slug = page.slug

    const requests: [string, string, unknown?][] = [
      ['GET', '/'],
      ['GET', '/login'],
      ['GET', '/assets/index.js'],
      ['GET', `/a/${slug}`],
      ['GET', `/e/${slug}`],
      ['GET', '/api/config'],
      ['GET', '/api/me'],
      ['GET', `/api/artifacts/${slug}`],
      ['GET', `/api/artifacts/${slug}/download`],
      ['GET', `/api/artifacts/${slug}/thumbnails/1`],
      ['GET', `/api/artifacts/${slug}/comments`],
      ['GET', `/api/oembed?url=${encodeURIComponent(`${env.appUrl}/a/${slug}`)}`],
      ['POST', '/api/auth/password/login', { email: owner.email, password: 'whatever password' }],
      ['POST', '/api/auth/email', { email: owner.email }],
      ['POST', '/api/auth/logout'],
      ['POST', `/api/artifacts/${slug}/unlock`, { password: 'x' }],
      ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' }],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['POST', '/oauth/register', { client_name: 'x', redirect_uris: ['http://127.0.0.1/cb'] }],
      ['GET', `/oauth/authorize?client_id=${client.client_id}&response_type=code`],
      ['POST', '/api/publish', { title: 'x', html: 'x' }],
      ['GET', '/healthz'],
      ['POST', `/api/artifacts/${slug}/v/1/`],
    ]
    for (const [method, path, json] of requests) {
      const res = await onContent(path, { method, json, cookie: owner.cookie, dest: 'document' })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.headers.getSetCookie(), `${method} ${path}`).toEqual([])
    }
    // The app's host still answers them
    expect((await call('/api/config')).status).toBe(200)
    expect((await call('/api/me', { cookie: owner.cookie })).status).toBe(200)
  })

  it('reads the host from X-Forwarded-Host only behind a trusted proxy', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', html: '<h1>Hi</h1>' })
    const base = `/api/artifacts/${page.slug}/v/1/`
    const viaProxy = { 'x-forwarded-host': 'content.test', 'sec-fetch-dest': 'iframe' }

    env.trustProxy = 0
    expect((await call(base, { headers: viaProxy })).status).toBe(302)
    env.trustProxy = 1
    expect((await call(base, { headers: viaProxy })).status).toBe(200)
    expect((await call('/api/config', { headers: viaProxy })).status).toBe(404)
    // The entry the outermost proxy added counts, not what the client claimed
    expect((await call('/api/config', { headers: { 'x-forwarded-host': 'content.test, localhost:5177' } })).status).toBe(200)
  })

  it('lets the app frame the content host when embedding is narrowed', async () => {
    env.embedFrameAncestors = "'self' https://www.notion.so"
    expect(contentCsp()).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self' https://www.notion.so http://localhost:5177",
    )
  })
})

describe('without CONTENT_ORIGIN', () => {
  beforeEach(() => {
    env.contentOrigin = null
  })

  it('serves page content from the app itself, on any host', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', html: '<h1>Hi</h1>' })
    const base = `/api/artifacts/${page.slug}/v/1/`
    const res = await frame(base)
    expect(res.status).toBe(200)
    expect(res.headers.get('vary')).toBe('Cookie')
    expect((await onContent(base)).status).toBe(200)
    expect((await onContent('/api/config')).status).toBe(200)

    const embed = await site.request(`/e/${page.slug}`)
    expect(await embed.text()).toContain(`src="${base}"`)
    expect(embed.headers.get('content-security-policy')).toContain("frame-src 'self';")
    env.embedFrameAncestors = "'self' https://www.notion.so"
    expect(contentCsp()).toBe("sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self' https://www.notion.so")
  })
})
