import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { versionId } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { putBlob } from '../../src/storage.js'
import { mountWeb } from '../../src/web.js'
import { addMember, call, createOrg, createPage, createUser } from './helpers.js'

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>The Artifact</title>
  </head>
  <body><div id="root"></div></body>
</html>`

// The built web app served next to the API, as in the Docker image
const site = new Hono()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-web-'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  mountWeb(site, dir)
})

async function shell(path: string, cookie?: string) {
  const res = await site.request(path, { headers: cookie ? { cookie } : {} })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  return res.text()
}

function meta(html: string, key: string): string | null {
  const match = html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)" />`))
  return match ? match[1] : null
}

// A rendered screenshot, stored the way thumbnails.ts stores one
async function addThumbnail(page: Artifact) {
  const image = Buffer.from('RIFF\0\0\0\0WEBPVP8 fake image')
  const hash = await putBlob(image)
  await db.insert(schema.artifactThumbnails).values({ versionId: (await versionId(page, page.currentVersion))!, sha256: hash, contentType: 'image/webp' })
}

describe('link previews', () => {
  it('a page anyone with the link can open unfurls with its title and screenshot', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'Q3 roadmap' })
    await addThumbnail(page)

    const html = await shell(`/a/${page.slug}`)
    expect(html).toContain('<title>Q3 roadmap | The Artifact</title>')
    expect(meta(html, 'og:title')).toBe('Q3 roadmap')
    expect(meta(html, 'og:url')).toBe(`http://localhost:5177/a/${page.slug}`)
    const image = meta(html, 'og:image')
    expect(image).toBe(`http://localhost:5177/api/artifacts/${page.slug}/thumbnails/1`)
    expect(meta(html, 'twitter:card')).toBe('summary_large_image')
    expect(html).toContain('<div id="root"></div>')

    // A crawler fetches the image with no cookies
    const res = await call(new URL(image!).pathname)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
  })

  it('without a screenshot, a link-shared page unfurls with its title only', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'No picture yet' })
    const html = await shell(`/a/${page.slug}`)
    expect(meta(html, 'og:title')).toBe('No picture yet')
    expect(meta(html, 'og:image')).toBeNull()
    expect(meta(html, 'twitter:card')).toBe('summary')
  })

  it('escapes the title', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: `</title><script>alert(1)</script> "quoted" & $& 'x'` })
    const html = await shell(`/a/${page.slug}`)
    expect(html).not.toContain('<script>')
    expect(html).toContain('<title>&#60;/title&#62;&#60;script&#62;alert(1)&#60;/script&#62; &#34;quoted&#34; &#38; $&#38; &#39;x&#39; | The Artifact</title>')
    expect(meta(html, 'og:title')).toBe('&#60;/title&#62;&#60;script&#62;alert(1)&#60;/script&#62; &#34;quoted&#34; &#38; $&#38; &#39;x&#39;')
  })

  it('restricted, organization and missing pages unfurl as plain "The Artifact", even for their owner', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    const restricted = await createPage(owner, { visibility: 'private', title: 'Secret plan' })
    const inOrg = await createPage(owner, { organizationId: org.id, visibility: 'organization', title: 'Org plan' })
    await addThumbnail(restricted)
    await addThumbnail(inOrg)

    const generic = await shell('/a/doesnotexist')
    expect(generic).toContain('<title>The Artifact</title>')
    expect(meta(generic, 'og:title')).toBe('The Artifact')
    expect(meta(generic, 'og:image')).toBeNull()
    expect(meta(generic, 'og:url')).toBeNull()
    expect(meta(generic, 'twitter:card')).toBe('summary')

    // Byte for byte the same, so a preview doesn't reveal that a page exists
    expect(await shell(`/a/${restricted.slug}`)).toBe(generic)
    expect(await shell(`/a/${restricted.slug}`, owner.cookie)).toBe(generic)
    expect(await shell(`/a/${inOrg.slug}`)).toBe(generic)
    expect(await shell(`/a/${inOrg.slug}`, member.cookie)).toBe(generic)
    expect(await shell('/a/Not-A-Slug')).toBe(generic)

    // And their screenshots stay behind sign-in
    expect((await call(`/api/artifacts/${restricted.slug}/thumbnails/1`)).status).toBe(404)
    expect((await call(`/api/artifacts/${inOrg.slug}/thumbnails/1`)).status).toBe(404)
  })

  it('a page that stops being shared by link loses its preview', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', title: 'Was public' })
    await addThumbnail(page)
    expect(meta(await shell(`/a/${page.slug}`), 'og:title')).toBe('Was public')

    const res = await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { visibility: 'private' } })
    expect(res.status).toBe(200)
    const html = await shell(`/a/${page.slug}`)
    expect(meta(html, 'og:title')).toBe('The Artifact')
    expect(html).not.toContain('Was public')
  })

  it('other app routes keep the plain shell', async () => {
    const html = await shell('/docs/sharing')
    expect(html).toBe(INDEX)
  })
})
