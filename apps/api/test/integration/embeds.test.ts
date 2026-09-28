import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { versionId } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { putBlob } from '../../src/storage.js'
import { mountWeb } from '../../src/web.js'
import { addMember, createOrg, createPage, createUser } from './helpers.js'

const INDEX = '<!doctype html><html><head><title>The Artifact</title></head><body><div id="root"></div></body></html>'
const APP = 'http://localhost:5177'
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

// The API with the built web app behind it, mounted in the same order as the Docker image
const site = new Hono()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-web-'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  site.route('/', app)
  mountWeb(site, dir)
})

const ancestors = env.embedFrameAncestors
afterEach(() => {
  env.embedFrameAncestors = ancestors
})

function get(path: string, cookie?: string) {
  return site.request(path, { headers: cookie ? { cookie } : {} })
}

function oembed(url: string, extra = '', cookie?: string) {
  return get(`/api/oembed?url=${encodeURIComponent(url)}${extra}`, cookie)
}

async function addThumbnail(page: Artifact) {
  const hash = await putBlob(Buffer.from('RIFF\0\0\0\0WEBPVP8 fake image'))
  await db.insert(schema.artifactThumbnails).values({ versionId: (await versionId(page, page.currentVersion))!, sha256: hash, contentType: 'image/webp' })
}

// The card with the one part that comes from the address (the link back) taken out
async function card(res: Response, slug: string) {
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toContain('text/html')
  return (await res.text()).replaceAll(slug, '<slug>')
}

describe('oEmbed', () => {
  it('describes a link-shared page as a rich embed', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'Q3 "roadmap" <b>' })
    const res = await oembed(`${APP}/a/${page.slug}`, '&format=json')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = await res.json()
    expect(body).toEqual({
      version: '1.0',
      type: 'rich',
      provider_name: 'The Artifact',
      provider_url: APP,
      title: 'Q3 "roadmap" <b>',
      html: `<iframe src="${APP}/e/${page.slug}" width="800" height="600" style="border:0" title="Q3 &#34;roadmap&#34; &#60;b&#62;" loading="lazy" allowfullscreen></iframe>`,
      width: 800,
      height: 600,
    })

    // The embed address and a trailing slash or query work as the url too
    expect((await oembed(`${APP}/e/${page.slug}`)).status).toBe(200)
    expect((await oembed(`${APP}/a/${page.slug}/?utm=x#top`)).status).toBe(200)
  })

  it('adds the screenshot once it is rendered, when it fits', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    expect((await (await oembed(`${APP}/a/${page.slug}`)).json()).thumbnail_url).toBeUndefined()

    await addThumbnail(page)
    const body = await (await oembed(`${APP}/a/${page.slug}`)).json()
    expect(body.thumbnail_url).toBe(`${APP}/api/artifacts/${page.slug}/thumbnails/1`)
    expect(body.thumbnail_width).toBe(640)
    expect(body.thumbnail_height).toBe(360)
    expect((await get(new URL(body.thumbnail_url).pathname)).status).toBe(200)

    const small = await (await oembed(`${APP}/a/${page.slug}`, '&maxwidth=400')).json()
    expect(small.thumbnail_url).toBeUndefined()
  })

  it('keeps within maxwidth and maxheight', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const body = await (await oembed(`${APP}/a/${page.slug}`, '&maxwidth=500&maxheight=300')).json()
    expect(body.width).toBe(500)
    expect(body.height).toBe(300)
    expect(body.html).toContain('width="500" height="300"')

    const large = await (await oembed(`${APP}/a/${page.slug}`, '&maxwidth=2000&maxheight=2000')).json()
    expect([large.width, large.height]).toEqual([800, 600])
    const junk = await (await oembed(`${APP}/a/${page.slug}`, '&maxwidth=abc&maxheight=-5')).json()
    expect([junk.width, junk.height]).toEqual([800, 600])
  })

  it('restricted, organization and missing pages answer the same 404, even for their owner', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    const restricted = await createPage(owner, { visibility: 'private', title: 'Secret plan' })
    const inOrg = await createPage(owner, { organizationId: org.id, visibility: 'organization', title: 'Org plan' })
    await addThumbnail(restricted)

    const answers = [
      await oembed(`${APP}/a/${restricted.slug}`),
      await oembed(`${APP}/a/${restricted.slug}`, '', owner.cookie),
      await oembed(`${APP}/a/${inOrg.slug}`, '', member.cookie),
      await oembed(`${APP}/a/doesnotexist`),
      await oembed(`https://elsewhere.example/a/${restricted.slug}`),
      await oembed(`${APP}/docs/sharing`),
      await oembed('not a url'),
    ]
    for (const res of answers) {
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    }
  })

  it('refuses other formats and a missing url', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    expect((await oembed(`${APP}/a/${page.slug}`, '&format=xml')).status).toBe(501)
    const res = await get('/api/oembed')
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe('url')
  })

  it('is advertised in the shell of link-shared pages only', async () => {
    const owner = await createUser()
    const shared = await createPage(owner, { visibility: 'link', title: 'Shared' })
    const restricted = await createPage(owner, { visibility: 'private', title: 'Secret' })

    const html = await (await get(`/a/${shared.slug}`)).text()
    const href = html.match(/<link rel="alternate" type="application\/json\+oembed" href="([^"]+)" title="Shared" \/>/)?.[1]
    expect(href).toBe(`${APP}/api/oembed?url=${encodeURIComponent(`${APP}/a/${shared.slug}`)}&#38;format=json`)
    const discovered = await get(new URL(href!.replaceAll('&#38;', '&')).pathname + new URL(href!.replaceAll('&#38;', '&')).search)
    expect((await discovered.json()).title).toBe('Shared')

    expect(await (await get(`/a/${restricted.slug}`, owner.cookie)).text()).not.toContain('oembed')
    expect(await (await get('/a/doesnotexist')).text()).not.toContain('oembed')
  })
})

describe('embeds', () => {
  it('a link-shared page embeds without the app, in a sandboxed frame any site may frame', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'Signups', html: '<h1>Signups by week</h1>' })
    const res = await get(`/e/${page.slug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-src 'self'")
    expect(csp).not.toContain('frame-ancestors')
    expect(res.headers.get('cache-control')).toBe('no-cache')

    const html = await res.text()
    expect(html).toContain('<title>Signups | The Artifact</title>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('id="root"')
    const frame = html.match(/<iframe class="page" src="([^"]+)" title="Signups" sandbox="([^"]+)"/)
    expect(frame?.[1]).toBe(`/api/artifacts/${page.slug}/v/1/`)
    expect(frame?.[2]).toContain('allow-scripts')
    expect(frame?.[2]).not.toContain('allow-same-origin')
    expect(html).toContain(`<a href="${APP}/a/${page.slug}" target="_blank" rel="noopener">Open in The Artifact</a>`)

    // The page itself keeps its sandbox and can be framed from the embed
    const content = await site.request(frame![1], { headers: { 'sec-fetch-dest': 'iframe' } })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-security-policy')).toBe(SANDBOX)
    expect(content.headers.get('x-frame-options')).toBeNull()
    expect(await content.text()).toBe('<h1>Signups by week</h1>')
  })

  it('restricted, organization and missing pages show the same sign-in card to everyone, their owner included', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    const restricted = await createPage(owner, { visibility: 'private', title: 'Secret plan', html: '<p>secret sauce</p>' })
    const inOrg = await createPage(owner, { organizationId: org.id, visibility: 'organization', title: 'Org plan' })
    await addThumbnail(restricted)

    const missing = await card(await get('/e/doesnotexist'), 'doesnotexist')
    expect(missing).toContain('Sign in to view this page')
    expect(missing).toContain(`<a href="${APP}/a/<slug>" target="_blank" rel="noopener">Open in The Artifact</a>`)
    expect(missing).toContain('<title>The Artifact</title>')
    expect(missing).not.toContain('<iframe')

    expect(await card(await get(`/e/${restricted.slug}`), restricted.slug)).toBe(missing)
    expect(await card(await get(`/e/${restricted.slug}`, owner.cookie), restricted.slug)).toBe(missing)
    expect(await card(await get(`/e/${inOrg.slug}`), inOrg.slug)).toBe(missing)
    expect(await card(await get(`/e/${inOrg.slug}`, member.cookie), inOrg.slug)).toBe(missing)
    expect(await card(await get(`/e/${inOrg.slug}`, owner.cookie), inOrg.slug)).toBe(missing)

    const odd = await get('/e/Not-A-Slug')
    expect(odd.status).toBe(404)
    expect(await odd.text()).toContain(`<a href="${APP}" target="_blank" rel="noopener">`)
  })

  it('a page that stops being shared by link stops showing at once', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'Was public' })
    expect((await get(`/e/${page.slug}`)).status).toBe(200)

    const res = await site.request(`/api/artifacts/${page.slug}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(res.status).toBe(200)
    const after = await get(`/e/${page.slug}`)
    expect(after.status).toBe(404)
    expect(await after.text()).not.toContain('Was public')
  })

  it('EMBED_FRAME_ANCESTORS limits who may frame embeds and page content', async () => {
    env.embedFrameAncestors = "'self' https://www.notion.so"
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    expect((await get(`/e/${page.slug}`)).headers.get('content-security-policy')).toContain("; frame-ancestors 'self' https://www.notion.so")
    expect((await get('/e/doesnotexist')).headers.get('content-security-policy')).toContain("; frame-ancestors 'self' https://www.notion.so")
    const content = await get(`/api/artifacts/${page.slug}/v/1/`)
    expect(content.headers.get('content-security-policy')).toBe(`${SANDBOX}; frame-ancestors 'self' https://www.notion.so`)
  })
})

describe('the app itself', () => {
  it('can only be framed by itself', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    for (const path of [`/a/${page.slug}`, '/a/doesnotexist', '/app', '/docs/sharing', '/index.html']) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('x-frame-options'), path).toBe('SAMEORIGIN')
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'self'")
    }
  })
})
