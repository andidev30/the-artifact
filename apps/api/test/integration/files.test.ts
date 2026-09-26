import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { signContentLink } from '../../src/content.js'
import { getBlob } from '../../src/storage.js'
import { db, schema } from '../../src/db/index.js'
import { addMember, call, callTool, connectAgent, createOrg, createUser, slugFrom, type TestUser } from './helpers.js'

const CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
// A 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const HTML = '<!doctype html><link rel="stylesheet" href="css/site.css"><img src="img/dot.png"><script src="app.js"></script><h1>Site</h1>'
const FILES = [
  { path: 'css/site.css', content: 'body { background: rgb(1, 2, 3) }' },
  { path: 'app.js', content: 'document.body.dataset.ran = "yes"' },
  { path: 'img/dot.png', content: PNG.toString('base64'), encoding: 'base64' as const },
  { path: 'data/points.json', content: '[1,2,3]' },
]

async function site(owner: TestUser, opts: { visibility?: 'private' | 'organization' | 'link'; organizationId?: string | null } = {}) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId: opts.organizationId ?? null,
    clientName: 'test-client',
    title: 'Site',
    html: HTML,
    files: FILES,
    visibility: opts.visibility,
  })
}

async function publishError(owner: TestUser, files: unknown[]) {
  try {
    await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'X', html: '<p>x</p>', files: files as never })
  } catch (err) {
    return (err as Error).message
  }
  return null
}

describe('publishing files', () => {
  it('refuses paths that leave the page or look odd', async () => {
    const owner = await createUser()
    for (const path of ['../secret.css', 'a/../../b.css', '/etc/passwd.txt', 'C:\\x.css', 'http://evil.test/x.js', 'a//b.css', '.env.txt', 'a/.git/x.txt', 'sp ace.css', 'q?.css', 'a%2e%2e.css', '']) {
      const message = await publishError(owner, [{ path, content: 'x' }])
      expect(message, path).not.toBeNull()
    }
    expect(await publishError(owner, [{ path: 'x'.repeat(197) + '.css', content: 'x' }])).toMatch(/longer than 200/)
    // A leading ./ is the same file
    expect(await publishError(owner, [{ path: './ok.css', content: 'x' }])).toBeNull()
    expect(await db.select().from(schema.artifactFiles)).toMatchObject([{ path: 'ok.css' }])
  })

  it('only accepts known file types, sent the right way', async () => {
    const owner = await createUser()
    expect(await publishError(owner, [{ path: 'run.exe', content: 'x' }])).toMatch(/isn't a supported file type/)
    expect(await publishError(owner, [{ path: 'page.php', content: 'x' }])).toMatch(/supported file type/)
    expect(await publishError(owner, [{ path: 'README', content: 'x' }])).toMatch(/supported file type/)
    expect(await publishError(owner, [{ path: 'logo.png', content: 'not base64' }])).toMatch(/binary file: send it with encoding "base64"/)
    expect(await publishError(owner, [{ path: 'logo.png', content: '@@@=', encoding: 'base64' }])).toMatch(/isn't valid base64/)
    expect(await publishError(owner, [{ path: 'x.css', content: 'x', encoding: 'hex' }])).toMatch(/unknown encoding/)
    expect(await publishError(owner, [{ path: 'index.html', content: 'x' }])).toMatch(/index.html is the page itself/)
    expect(await publishError(owner, [{ path: 'a.css', content: 'x' }, { path: 'A.css', content: 'y' }])).toMatch(/Two files have the path/)
    // Text types can come as base64 too, and other HTML pages are fine
    expect(await publishError(owner, [{ path: 'about.html', content: Buffer.from('<p>about</p>').toString('base64'), encoding: 'base64' }])).toBeNull()
  })

  it('enforces the size and count limits', async () => {
    const owner = await createUser()
    const mb = 1024 * 1024
    expect(await publishError(owner, [{ path: 'big.txt', content: 'x'.repeat(5 * mb + 1) }])).toMatch(/"big.txt" is larger than 5 MB/)
    expect(await publishError(owner, [{ path: 'ok.txt', content: 'x'.repeat(5 * mb) }])).toBeNull()
    const three = [1, 2, 3].map((n) => ({ path: `part${n}.txt`, content: 'x'.repeat(4 * mb) }))
    expect(await publishError(owner, three)).toMatch(/add up to more than 10 MB/)
    const many = Array.from({ length: 101 }, (_, n) => ({ path: `f${n}.txt`, content: 'x' }))
    expect(await publishError(owner, many)).toMatch(/at most 100 files/)
    expect(await publishError(owner, many.slice(0, 100))).toBeNull()
  })

  it('stores each file with its type, size and hash', async () => {
    const owner = await createUser()
    await site(owner)
    const rows = await db.select().from(schema.artifactFiles)
    const png = rows.find((r) => r.path === 'img/dot.png')!
    expect(png).toMatchObject({ contentType: 'image/png', size: PNG.length })
    expect(png.sha256).toBe(createHash('sha256').update(PNG).digest('hex'))
    // The content is in object storage under its hash
    expect(Buffer.compare((await getBlob(png.sha256))!, PNG)).toBe(0)
    expect(rows.find((r) => r.path === 'css/site.css')?.contentType).toBe('text/css; charset=utf-8')
  })
})

describe('serving a version as a document tree', () => {
  it('resolves relative paths next to the entry, with safe headers', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    const base = `/api/artifacts/${page.slug}/v/1/`

    const entry = await call(base)
    expect(entry.status).toBe(200)
    expect(await entry.text()).toBe(HTML)
    expect(entry.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect((await call(`${base}index.html`)).status).toBe(200)

    // What the browser asks for when it resolves href="css/site.css" against the entry
    const css = await call(new URL('css/site.css', `http://x${base}`).pathname)
    expect(css.status).toBe(200)
    expect(await css.text()).toBe('body { background: rgb(1, 2, 3) }')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    for (const res of [entry, css]) {
      expect(res.headers.get('content-security-policy')).toBe(CSP)
      // The sandboxed frame's fetch() and fonts are cross-origin requests from an opaque origin
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    }

    const png = await call(`${base}img/dot.png`)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(Buffer.compare(Buffer.from(await png.arrayBuffer()), PNG)).toBe(0)
    expect((await call(`${base}data/points.json`)).headers.get('content-type')).toBe('application/json; charset=utf-8')

    // Same content, same ETag: the browser revalidates for free
    const etag = css.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    expect((await call(`${base}css/site.css`, { headers: { 'if-none-match': etag } })).status).toBe(304)

    expect((await call(`${base}missing.css`)).status).toBe(404)
    expect((await call(`${base}css%2F..%2Fapp.js`)).status).toBe(404)
    expect((await call(`${base}%2Fetc%2Fpasswd.txt`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/v/2/`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/v/0/`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/v/abc/`)).status).toBe(404)

    // Without the trailing slash relative URLs would resolve one level up
    const bare = await call(`/api/artifacts/${page.slug}/v/1`)
    expect(bare.status).toBe(301)
    expect(bare.headers.get('location')).toBe(base)
  })

  it('single-file pages work the same as before', async () => {
    const owner = await createUser()
    const res = await callTool((await connectAgent(owner)).access_token, 'publish_artifact', { title: 'One', html: '<h1>one</h1>', visibility: 'link' })
    const slug = slugFrom(res.text)
    expect(res.text).not.toContain('Files:')
    expect(await (await call(`/api/artifacts/${slug}/v/1/`)).text()).toBe('<h1>one</h1>')
    expect(await db.select().from(schema.artifactFiles)).toEqual([])
    // The old thumbnail link now points at the tree
    expect((await call(`/api/artifacts/${slug}/content`)).headers.get('location')).toBe(`/api/artifacts/${slug}/v/1/`)
  })

  it('files of restricted pages need access, for every role', async () => {
    const orgOwner = await createUser({ email: 'founder@example.com' })
    const org = await createOrg(orgOwner)
    const author = await createUser({ email: 'author@example.com' })
    const member = await createUser({ email: 'member@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    await addMember(org.id, author, 'member')
    await addMember(org.id, member, 'member')

    const expectations = {
      private: { author: 200, orgOwner: 200, viewer: 200, member: 404, stranger: 404, anonymous: 404 },
      organization: { author: 200, orgOwner: 200, viewer: 200, member: 200, stranger: 404, anonymous: 404 },
      link: { author: 200, orgOwner: 200, viewer: 200, member: 200, stranger: 200, anonymous: 200 },
    } as const
    const people = { author, orgOwner, viewer, member, stranger }
    for (const [visibility, row] of Object.entries(expectations) as [keyof typeof expectations, (typeof expectations)['private']][]) {
      const page = await site(author, { visibility, organizationId: org.id })
      await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })
      for (const [who, status] of Object.entries(row)) {
        const cookie = who === 'anonymous' ? undefined : people[who as keyof typeof people].cookie
        for (const path of ['', 'app.js', 'img/dot.png']) {
          expect((await call(`/api/artifacts/${page.slug}/v/1/${path}`, { cookie })).status, `${visibility} ${who} ${path}`).toBe(status)
        }
      }
    }
  })

  it('browsers continue under a link token, because sandboxed frames send no cookie for subresources', async () => {
    const owner = await createUser()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const page = await site(owner)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })
    const base = `/api/artifacts/${page.slug}/v/1/`

    // The frame's own navigation carries the cookie; it is sent on under a token
    const nav = await call(base, { cookie: viewer.cookie, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(nav.status).toBe(302)
    expect(nav.headers.get('cache-control')).toBe('no-store')
    const location = nav.headers.get('location')!
    expect(location).toMatch(new RegExp(`^${base}~[0-9a-f]{32}\\.[0-9a-z]+\\.[A-Za-z0-9_-]{32}/$`))

    // Everything under the token works without a cookie, as the sandboxed frame will ask
    expect(await (await call(location)).text()).toBe(HTML)
    const js = await call(`${location}app.js`, { headers: { 'sec-fetch-dest': 'script' } })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('content-security-policy')).toBe(CSP)
    expect((await call(`${location}img/dot.png`)).status).toBe(200)

    // Top-level opens are sent on too; people without access and anonymous visitors are not
    expect((await call(`${base}app.js`, { cookie: owner.cookie, headers: { 'sec-fetch-dest': 'document' } })).status).toBe(302)
    expect((await call(base, { headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(404)
    const stranger = await createUser()
    expect((await call(base, { cookie: stranger.cookie, headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(404)

    // A token is for one person, one page and one version
    const token = location.slice(base.length + 1, -1)
    const other = await site(owner)
    await db.insert(schema.artifactShares).values({ artifactId: other.id, email: viewer.email, role: 'viewer' })
    expect((await call(`/api/artifacts/${other.slug}/v/1/~${token}/app.js`)).status).toBe(404)
    expect((await call(`${base}~${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}/app.js`)).status).toBe(404)
    expect((await call(`${base}~nonsense/app.js`)).status).toBe(404)
    const [a] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    const expired = await signContentLink(viewer.id, a, 1, Date.now() - 14 * 3600_000)
    expect((await call(`${base}~${expired}/app.js`)).status).toBe(404)

    // Removing the person locks them out of the files at once
    await db.delete(schema.artifactShares).where(eq(schema.artifactShares.artifactId, page.id))
    expect((await call(`${location}app.js`)).status).toBe(404)
  })

  it('pages anyone can open need no token', async () => {
    const owner = await createUser()
    const page = await site(owner, { visibility: 'link' })
    const res = await call(`/api/artifacts/${page.slug}/v/1/`, { cookie: owner.cookie, headers: { 'sec-fetch-dest': 'iframe' } })
    expect(res.status).toBe(200)
    expect((await call(`/api/artifacts/${page.slug}/v/1/app.js`, { headers: { 'sec-fetch-dest': 'script' } })).status).toBe(200)
  })

  it('older versions are for editors, like the history', async () => {
    const owner = await createUser()
    const editor = await createUser({ email: 'editor@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const page = await site(owner, { visibility: 'link' })
    await db.insert(schema.artifactShares).values([
      { artifactId: page.id, email: editor.email, role: 'editor' },
      { artifactId: page.id, email: viewer.email, role: 'viewer' },
    ])
    await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html: '<p>v2</p>', slug: page.slug })

    const old = `/api/artifacts/${page.slug}/v/1/app.js`
    expect((await call(old)).status).toBe(404)
    expect((await call(old, { cookie: viewer.cookie })).status).toBe(404)
    expect((await call(old, { cookie: editor.cookie })).status).toBe(200)
    expect((await call(old, { cookie: owner.cookie })).status).toBe(200)
    // Even on a link page, an old version in a browser goes through a token
    expect((await call(`/api/artifacts/${page.slug}/v/1/`, { cookie: editor.cookie, headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(302)
    expect(await (await call(`/api/artifacts/${page.slug}/v/2/`)).text()).toBe('<p>v2</p>')
    expect((await call(`/api/artifacts/${page.slug}/v/2/app.js`)).status).toBe(404)
  })

  it('restoring a multi-file version brings its files back', async () => {
    const owner = await createUser()
    const page = await site(owner)
    await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Site', html: '<p>plain</p>', slug: page.slug })

    const res = await call(`/api/artifacts/${page.slug}/versions/1/restore`, { method: 'POST', cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect((await res.json()).version).toBe(3)
    const base = `/api/artifacts/${page.slug}/v/3/`
    expect(await (await call(base, { cookie: owner.cookie })).text()).toBe(HTML)
    expect(await (await call(`${base}css/site.css`, { cookie: owner.cookie })).text()).toBe('body { background: rgb(1, 2, 3) }')
    const png = await call(`${base}img/dot.png`, { cookie: owner.cookie })
    expect(Buffer.compare(Buffer.from(await png.arrayBuffer()), PNG)).toBe(0)
    // Version 1 keeps its own copy
    expect((await db.select().from(schema.artifactFiles)).length).toBe(FILES.length * 2)

    const versions = await (await call(`/api/artifacts/${page.slug}/versions/1`, { cookie: owner.cookie })).json()
    expect(versions.contentUrl).toBe(`/api/artifacts/${page.slug}/v/1/`)
  })

  it('deleting a page deletes its files', async () => {
    const owner = await createUser()
    const page = await site(owner)
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect(await db.select().from(schema.artifactFiles)).toEqual([])
  })
})

describe('multi-file pages over MCP', () => {
  it('publishes files and reads them back', async () => {
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    const res = await callTool(token, 'publish_artifact', { title: 'Site', html: HTML, files: FILES })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Files: index.html and 4 more.')
    const slug = slugFrom(res.text)

    const read = await callTool(token, 'get_artifact', { artifact_id: slug })
    expect(read.text).toContain('- index.html (')
    expect(read.text).toContain('- css/site.css (33 B)')
    expect(read.text).toContain(`- img/dot.png (${PNG.length} B)`)
    expect(read.text.endsWith(HTML)).toBe(true)

    const css = await callTool(token, 'get_artifact', { artifact_id: slug, path: 'css/site.css' })
    expect(css.text).toContain('Encoding: utf8')
    expect(css.text.endsWith('body { background: rgb(1, 2, 3) }')).toBe(true)
    const png = await callTool(token, 'get_artifact', { artifact_id: slug, path: 'img/dot.png' })
    expect(png.text).toContain('Type: image/png')
    expect(png.text.endsWith(PNG.toString('base64'))).toBe(true)
    expect((await callTool(token, 'get_artifact', { artifact_id: slug, path: 'index.html' })).text.endsWith(HTML)).toBe(true)

    const missing = await callTool(token, 'get_artifact', { artifact_id: slug, path: 'nope.css' })
    expect(missing).toMatchObject({ isError: true })
    expect((await callTool(token, 'get_artifact', { artifact_id: slug, path: '../x' })).isError).toBe(true)
  })

  it('reports invalid files as a tool error and publishes nothing', async () => {
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    const res = await callTool(token, 'publish_artifact', { title: 'Bad', html: HTML, files: [{ path: '../up.css', content: 'x' }] })
    expect(res).toMatchObject({ isError: true, text: 'The path "../up.css" can\'t contain "." or ".." segments.' })
    expect(await db.select().from(schema.artifacts)).toEqual([])
  })

  it('each version has its own full set of files', async () => {
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Site', html: HTML, files: FILES })).text)
    await callTool(token, 'publish_artifact', { title: 'Site', html: HTML, artifact_id: slug, files: [{ path: 'app.js', content: 'v2()' }] })
    expect(await (await call(`/api/artifacts/${slug}/v/2/app.js`, { cookie: owner.cookie })).text()).toBe('v2()')
    expect((await call(`/api/artifacts/${slug}/v/2/css/site.css`, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${slug}/v/1/css/site.css`, { cookie: owner.cookie })).status).toBe(200)
  })
})
