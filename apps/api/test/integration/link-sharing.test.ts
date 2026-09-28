import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { findBySlug, versionId } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { putBlob } from '../../src/storage.js'
import { forgetRecentViews, totalViews } from '../../src/views.js'
import { mountWeb } from '../../src/web.js'
import { call, callTool, connectAgent, createPage, createUser, flushViews, type TestUser } from './helpers.js'

const INDEX = '<!doctype html><html><head><title>The Artifact</title></head><body><div id="root"></div></body></html>'

// The API with the built web app behind it, as in the Docker image, for link previews and embeds
const site = new Hono()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-web-'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  site.route('/', app)
  mountWeb(site, dir)
})

const rateLimits = env.rateLimits
afterEach(() => {
  env.rateLimits = rateLimits
})

function patch(slug: string, user: TestUser, json: Record<string, unknown>) {
  return call(`/api/artifacts/${slug}`, { method: 'PATCH', cookie: user.cookie, json })
}

function unlock(slug: string, password: string, cookie?: string) {
  return call(`/api/artifacts/${slug}/unlock`, { json: { password }, cookie })
}

// "page_link=<token>" from the unlock response, with the path it is scoped to
function unlockCookie(res: Response) {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('page_link='))!
  return { cookie: header.split(';')[0], path: header.match(/Path=([^;]+)/i)?.[1] }
}

async function addThumbnail(page: Artifact) {
  const hash = await putBlob(Buffer.from('RIFF\0\0\0\0WEBPVP8 fake image'))
  await db.insert(schema.artifactThumbnails).values({ versionId: (await versionId(page, page.currentVersion))!, sha256: hash, contentType: 'image/webp' })
}

// Everything a signed-out visitor, a crawler or an embedding site can learn about a page
async function outsideView(slug: string) {
  const shell = await (await site.request(`/a/${slug}`)).text()
  const embed = await site.request(`/e/${slug}`)
  const oembed = await site.request(`/api/oembed?url=${encodeURIComponent(`http://localhost:5177/a/${slug}`)}`)
  return {
    details: (await call(`/api/artifacts/${slug}`)).status,
    content: (await call(`/api/artifacts/${slug}/v/1/`, { headers: { 'sec-fetch-dest': 'iframe' } })).status,
    thumbnail: (await call(`/api/artifacts/${slug}/thumbnails/1`)).status,
    download: (await call(`/api/artifacts/${slug}/download`)).status,
    shell,
    embed: { status: embed.status, html: await embed.text() },
    oembed: oembed.status,
  }
}

describe('link expiry', () => {
  it('an expired link opens nothing and previews like a missing page, while people with access still open it', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Launch plan', visibility: 'link' })
    await addThumbnail(page)

    const open = await outsideView(page.slug)
    expect(open.details).toBe(200)
    expect(open.shell).toContain('Launch plan')

    await db
      .update(schema.artifacts)
      .set({ linkExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.artifacts.id, page.id))
    const expired = await outsideView(page.slug)
    const missing = await outsideView('doesnotexist')
    expect(expired.details).toBe(404)
    expect(expired.content).toBe(404)
    expect(expired.thumbnail).toBe(404)
    expect(expired.download).toBe(404)
    expect(expired.oembed).toBe(404)
    expect(expired.embed.status).toBe(404)
    expect(expired.shell).not.toContain('Launch plan')
    expect(expired.shell).not.toContain('thumbnails')
    expect(expired.shell.replaceAll(page.slug, 'x')).toBe(missing.shell.replaceAll('doesnotexist', 'x'))
    expect(expired.embed.html.replaceAll(page.slug, 'x')).toBe(missing.embed.html.replaceAll('doesnotexist', 'x'))

    // Signed in without access of their own: the same
    const stranger = await createUser()
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: stranger.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie })).status).toBe(200)
  })

  it('is set and removed in the share settings, as a date or a date and time in the future', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })

    const bad = await patch(page.slug, owner, { linkExpiresAt: 'next tuesday' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Give the expiry as a date like 2026-12-31, or a date and time.', field: 'linkExpiresAt' })
    const past = await patch(page.slug, owner, { linkExpiresAt: '2020-01-01' })
    expect(await past.json()).toEqual({ error: 'Choose an expiry in the future.', field: 'linkExpiresAt' })

    const res = await patch(page.slug, owner, { linkExpiresAt: '2999-12-31' })
    expect(res.status).toBe(200)
    expect((await res.json()).link).toMatchObject({ expiresAt: '2999-12-31T23:59:59.999Z', password: false, expired: false })
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(200)

    const sharing = await (await call(`/api/artifacts/${page.slug}/sharing`, { cookie: owner.cookie })).json()
    expect(sharing.link).toMatchObject({ expiresAt: '2999-12-31T23:59:59.999Z', password: false, expired: false })

    const cleared = await patch(page.slug, owner, { linkExpiresAt: null })
    expect((await cleared.json()).link.expiresAt).toBeNull()
  })

  it('only editors change the link', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const stranger = await createUser()
    expect((await patch(page.slug, stranger, { linkPassword: 'hunter2hunter2' })).status).toBe(404)
    expect((await patch(page.slug, stranger, { rotateLink: true })).status).toBe(404)
    expect((await findBySlug(page.slug))?.linkPasswordHash).toBeNull()
  })
})

describe('link password', () => {
  async function protectedPage() {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Board deck', visibility: 'link', html: '<h1>Numbers</h1>' })
    await addThumbnail(page)
    const res = await patch(page.slug, owner, { linkPassword: 'correct horse' })
    expect(res.status).toBe(200)
    expect((await res.json()).link.password).toBe(true)
    return { owner, page }
  }

  it('is stored hashed and must be long enough', async () => {
    const { owner, page } = await protectedPage()
    const stored = (await findBySlug(page.slug))!.linkPasswordHash!
    expect(stored).toMatch(/^scrypt\$/)
    expect(stored).not.toContain('correct horse')
    const short = await patch(page.slug, owner, { linkPassword: 'short' })
    expect(await short.json()).toEqual({ error: 'Use at least 8 characters for the password.', field: 'linkPassword' })
  })

  it('asks for the password without saying what the page is, and previews like a missing page', async () => {
    const { page } = await protectedPage()
    const details = await call(`/api/artifacts/${page.slug}`)
    expect(details.status).toBe(401)
    expect(await details.json()).toEqual({ error: 'Enter the password to open this page.', field: 'password' })

    const outside = await outsideView(page.slug)
    const missing = await outsideView('doesnotexist')
    expect(outside.content).toBe(404)
    expect(outside.thumbnail).toBe(404)
    expect(outside.download).toBe(404)
    expect(outside.oembed).toBe(404)
    expect(outside.embed.status).toBe(404)
    expect(outside.shell).not.toContain('Board deck')
    expect(outside.shell.replaceAll(page.slug, 'x')).toBe(missing.shell.replaceAll('doesnotexist', 'x'))
    expect(outside.embed.html.replaceAll(page.slug, 'x')).toBe(missing.embed.html.replaceAll('doesnotexist', 'x'))

    // Missing, expired and unprotected pages have nothing to unlock
    expect((await unlock('doesnotexist', 'correct horse')).status).toBe(404)
  })

  it('opens the page and its content once entered, until the password changes', async () => {
    const { owner, page } = await protectedPage()
    const wrong = await unlock(page.slug, 'wrong password')
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'That password is wrong.', field: 'password' })
    expect(wrong.headers.getSetCookie().some((c) => c.startsWith('page_link='))).toBe(false)

    const right = await unlock(page.slug, 'correct horse')
    expect(right.status).toBe(204)
    const { cookie, path } = unlockCookie(right)
    expect(path).toBe(`/api/artifacts/${page.slug}`)
    expect(right.headers.getSetCookie().find((c) => c.startsWith('page_link='))).toMatch(/HttpOnly/i)

    const details = await call(`/api/artifacts/${page.slug}`, { cookie })
    expect(details.status).toBe(200)
    expect((await details.json()).title).toBe('Board deck')
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/1`, { cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}/download`, { cookie })).status).toBe(200)

    // The sandboxed frame's navigation carries the cookie; its files load under a token in the path
    const base = `/api/artifacts/${page.slug}/v/1/`
    const nav = await call(base, { cookie, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(nav.status).toBe(302)
    const location = nav.headers.get('location')!
    expect(location).toMatch(new RegExp(`^${base}~[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`))
    const content = await call(location)
    expect(content.status).toBe(200)
    expect(await content.text()).toBe('<h1>Numbers</h1>')
    // Change the token's last character to a different one: replacing it with a fixed letter left it
    // unchanged whenever it already was that letter
    const token = location.slice(base.length + 1, -1)
    const tampered = token.slice(0, -1) + (token.endsWith('x') ? 'y' : 'x')
    expect((await call(`${base}~${tampered}/`)).status).toBe(404)

    // Still no preview: crawlers never have the cookie
    expect(await (await site.request(`/a/${page.slug}`)).text()).not.toContain('Board deck')

    // A new password locks out everyone who entered the old one
    await patch(page.slug, owner, { linkPassword: 'battery staple' })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie })).status).toBe(401)
    expect((await call(location)).status).toBe(404)

    // Without a password the link is open again
    await patch(page.slug, owner, { linkPassword: null })
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(200)
    expect((await unlock(page.slug, 'battery staple')).status).toBe(404)
  })

  it('does not apply to people with access of their own', async () => {
    const { owner, page } = await protectedPage()
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie })).status).toBe(200)
    const nav = await call(`/api/artifacts/${page.slug}/v/1/`, { cookie: owner.cookie, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(nav.headers.get('location')).toMatch(/~[0-9a-f]{32}\./)
  })

  it('lets a signed-in visitor who entered it comment', async () => {
    const { page } = await protectedPage()
    const visitor = await createUser()
    expect((await call(`/api/artifacts/${page.slug}/comments`, { cookie: visitor.cookie })).status).toBe(404)
    const { cookie } = unlockCookie(await unlock(page.slug, 'correct horse'))
    const both = `${visitor.cookie}; ${cookie}`
    expect((await call(`/api/artifacts/${page.slug}/comments`, { cookie: both })).status).toBe(200)
  })

  it('an expired link asks for no password', async () => {
    const { page } = await protectedPage()
    await db
      .update(schema.artifacts)
      .set({ linkExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.artifacts.id, page.id))
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(404)
    expect((await unlock(page.slug, 'correct horse')).status).toBe(404)
  })

  it('limits wrong passwords per page, from any address', async () => {
    env.rateLimits = 'link-password=3/15m'
    const { page } = await protectedPage()
    for (let i = 0; i < 3; i++) expect((await unlock(page.slug, `wrong ${i} guess`)).status).toBe(401)
    const limited = await unlock(page.slug, 'correct horse')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    expect((await limited.json()).error).toMatch(/^Too many wrong passwords for this page\. Try again in/)
  })

  it('checks no more wrong passwords than the limit when they arrive at the same time', async () => {
    env.rateLimits = 'link-password=5/15m'
    const { page } = await protectedPage()
    const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) => unlock(page.slug, `wrong ${i} guess`).then((r) => r.status)))
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
  })

  it('does not count right passwords against the limit', async () => {
    env.rateLimits = 'link-password=3/15m'
    const { page } = await protectedPage()
    for (let i = 0; i < 6; i++) expect((await unlock(page.slug, 'correct horse')).status).toBe(204)
    for (let i = 0; i < 3; i++) expect((await unlock(page.slug, `wrong ${i} guess`)).status).toBe(401)
    expect((await unlock(page.slug, 'correct horse')).status).toBe(429)
  })
})

describe('resetting the link', () => {
  async function resetPage() {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Roadmap', visibility: 'link', html: '<h1>Plans</h1>' })
    await addThumbnail(page)
    const res = await patch(page.slug, owner, { rotateLink: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    const key = new URL(body.link.url).searchParams.get('k')!
    expect(body.slug).toBe(page.slug)
    expect(body.link.url).toBe(`http://localhost:5177/a/${page.slug}?k=${key}`)
    expect(body.link.embedUrl).toBe(`http://localhost:5177/e/${page.slug}?k=${key}`)
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    return { owner, page, key }
  }

  it('keeps the page address for people with access, and makes the plain address a missing page to everyone else', async () => {
    const { owner, page } = await resetPage()
    const viewer = await createUser({ email: 'viewer@example.com' })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: ['viewer@example.com'], notify: false } })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: viewer.cookie })).status).toBe(200)

    const plain = await outsideView(page.slug)
    const missing = await outsideView('doesnotexist')
    expect(plain.details).toBe(404)
    expect(plain.content).toBe(404)
    expect(plain.thumbnail).toBe(404)
    expect(plain.download).toBe(404)
    expect(plain.oembed).toBe(404)
    expect(plain.embed.status).toBe(404)
    expect(plain.shell.replaceAll(page.slug, 'x')).toBe(missing.shell.replaceAll('doesnotexist', 'x'))
    expect(plain.embed.html.replaceAll(page.slug, 'x')).toBe(missing.embed.html.replaceAll('doesnotexist', 'x'))
    expect((await call(`/api/artifacts/${page.slug}?k=wrong`)).status).toBe(404)
  })

  it('opens the page, its content, preview, embed and oEmbed with the new key', async () => {
    const { page, key } = await resetPage()
    const q = `?k=${encodeURIComponent(key)}`

    // The app asks with the key once; a cookie carries it to the frame and the rest
    const details = await call(`/api/artifacts/${page.slug}${q}`)
    expect(details.status).toBe(200)
    const { cookie, path } = unlockCookie(details)
    expect(path).toBe(`/api/artifacts/${page.slug}`)
    const base = `/api/artifacts/${page.slug}/v/1/`
    const tokenPath = new RegExp(`^${base}~[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`)
    const nav = await call(base, { cookie, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(nav.status).toBe(302)
    const location = nav.headers.get('location')!
    expect(location).toMatch(tokenPath)
    expect(await (await call(location)).text()).toBe('<h1>Plans</h1>')
    expect((await call(`/api/artifacts/${page.slug}/download`, { cookie })).status).toBe(200)

    // Embeds have no cookie: the frame's address carries the key, and is sent on without it
    const direct = await call(`${base}${q}`, { headers: { 'sec-fetch-dest': 'iframe' } })
    expect(direct.headers.get('location')).toMatch(tokenPath)

    const shell = await (await site.request(`/a/${page.slug}${q}`)).text()
    expect(shell).toContain('Roadmap')
    expect(shell).toContain(`thumbnails/1?k=${key}`)
    expect((await call(`/api/artifacts/${page.slug}/thumbnails/1${q}`)).status).toBe(200)

    const embed = await site.request(`/e/${page.slug}${q}`)
    expect(embed.status).toBe(200)
    expect(await embed.text()).toContain(`src="/api/artifacts/${page.slug}/v/1/?k=${key}"`)

    const oembed = await site.request(`/api/oembed?url=${encodeURIComponent(`http://localhost:5177/a/${page.slug}${q}`)}`)
    expect(oembed.status).toBe(200)
    const described = await oembed.json()
    expect(described.title).toBe('Roadmap')
    expect(described.html).toContain(`/e/${page.slug}?k=${key}`)
  })

  it('counts a visit by the public link as a view, without the visitor’s identity', async () => {
    forgetRecentViews()
    const { page, key } = await resetPage()
    const stranger = await createUser()
    const details = await call(`/api/artifacts/${page.slug}?k=${key}`, { cookie: stranger.cookie })
    const both = `${stranger.cookie}; ${unlockCookie(details).cookie}`
    const base = `/api/artifacts/${page.slug}/v/1/`
    const location = (await call(base, { cookie: both, headers: { 'sec-fetch-dest': 'iframe' } })).headers.get('location')!
    expect((await call(location, { cookie: both, headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(200)
    await flushViews()
    expect(await totalViews(page)).toBe(1)
    expect(await db.select().from(schema.artifactViews)).toEqual([])
  })

  it('makes every earlier key, cookie and frame token useless', async () => {
    const { owner, page, key } = await resetPage()
    const details = await call(`/api/artifacts/${page.slug}?k=${key}`)
    const { cookie } = unlockCookie(details)
    const base = `/api/artifacts/${page.slug}/v/1/`
    const location = (await call(base, { cookie, headers: { 'sec-fetch-dest': 'iframe' } })).headers.get('location')!

    await patch(page.slug, owner, { rotateLink: true })
    expect((await call(`/api/artifacts/${page.slug}?k=${key}`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie })).status).toBe(404)
    expect((await call(location)).status).toBe(404)
    expect((await site.request(`/e/${page.slug}?k=${key}`)).status).toBe(404)
    expect(await (await site.request(`/a/${page.slug}?k=${key}`)).text()).not.toContain('Roadmap')
  })

  it('with a password, asks for it only with the current key', async () => {
    const { owner, page, key } = await resetPage()
    await patch(page.slug, owner, { linkPassword: 'correct horse' })
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}?k=${key}`)).status).toBe(401)
    expect((await unlock(page.slug, 'correct horse')).status).toBe(404)
    const right = await call(`/api/artifacts/${page.slug}/unlock`, { json: { password: 'correct horse', k: key } })
    expect(right.status).toBe(204)
    const { cookie } = unlockCookie(right)
    expect((await call(`/api/artifacts/${page.slug}`, { cookie })).status).toBe(200)
  })
})

describe('set_artifact_visibility', () => {
  it('sets an expiry and a password, makes a new link, and explains mistakes', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { title: 'Pricing', visibility: 'private' })
    const { access_token } = await connectAgent(owner)

    const set = await callTool(access_token, 'set_artifact_visibility', {
      artifact_id: page.slug,
      visibility: 'link',
      link_expires: '2999-01-31',
      link_password: 'open sesame',
    })
    expect(set.isError).toBe(false)
    expect(set.text).toContain('"Pricing" is now shared with anyone who has the link (until 2999-01-31 23:59 UTC, with a password).')
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(401)

    // Without visibility, the rest still changes
    const cleared = await callTool(access_token, 'set_artifact_visibility', { artifact_id: page.slug, link_password: '', link_expires: 'never' })
    expect(cleared.text).toContain('"Pricing" is now shared with anyone who has the link.')
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(200)

    const rotated = await callTool(access_token, 'set_artifact_visibility', { artifact_id: page.slug, rotate_link: true })
    expect(rotated.text).toContain('The public link was reset; earlier public links no longer work.')
    expect(rotated.text).toContain(`Link: http://localhost:5177/a/${page.slug}\n`)
    const publicUrl = rotated.text.match(/Public link: (\S+)/)?.[1]
    expect(publicUrl).toMatch(new RegExp(`^http://localhost:5177/a/${page.slug}\\?k=[A-Za-z0-9_-]{22}$`))
    expect((await call(`/api/artifacts/${page.slug}`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}${new URL(publicUrl!).search}`)).status).toBe(200)
    // The public link works as an id too
    const byLink = await callTool(access_token, 'rename_artifact', { artifact_id: publicUrl, title: 'Pricing' })
    expect(byLink.isError).toBe(false)
    const slug = page.slug

    const nothing = await callTool(access_token, 'set_artifact_visibility', { artifact_id: slug })
    expect(nothing).toEqual({ isError: true, text: 'Say what to change: visibility, link_expires, link_password or rotate_link.' })
    const past = await callTool(access_token, 'set_artifact_visibility', { artifact_id: slug, link_expires: '2001-01-01' })
    expect(past).toEqual({ isError: true, text: 'Choose an expiry in the future.' })
    const short = await callTool(access_token, 'set_artifact_visibility', { artifact_id: slug, link_password: 'abc' })
    expect(short).toEqual({ isError: true, text: 'Use at least 8 characters for the password.' })

    const restricted = await callTool(access_token, 'set_artifact_visibility', { artifact_id: slug, visibility: 'private', link_password: 'later on please' })
    expect(restricted.text).toContain('The public link, its expiry and its password apply once visibility is link.')
  })
})
