import { describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { unzip } from '../unzip.js'
import { call, callTool, connectAgent, createUser, type TestUser } from './helpers.js'

// A 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function site(owner: TestUser, html: string, slug?: string) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId: null,
    clientName: 'test-client',
    title: 'Signups by week',
    html,
    files: [
      { path: 'css/site.css', content: 'body { color: red }' },
      { path: 'img/dot.png', content: PNG.toString('base64'), encoding: 'base64' },
    ],
    slug,
  })
}

async function files(res: Response) {
  expect(res.status).toBe(200)
  const entries = unzip(Buffer.from(await res.arrayBuffer()))
  return Object.fromEntries(entries.map((e) => [e.path, e.content]))
}

describe('downloading a page as a zip', () => {
  it('holds index.html and every file of the current version', async () => {
    const owner = await createUser()
    const page = await site(owner, '<h1>v1</h1>')
    const res = await call(`/api/artifacts/${page.slug}/download`, { cookie: owner.cookie })
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="signups-by-week-v1.zip"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const got = await files(res)
    expect(Object.keys(got).sort()).toEqual(['css/site.css', 'img/dot.png', 'index.html'])
    expect(got['index.html'].toString()).toBe('<h1>v1</h1>')
    expect(got['css/site.css'].toString()).toBe('body { color: red }')
    expect(got['img/dot.png'].equals(PNG)).toBe(true)
  })

  it('older versions are for editors, like the history', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const page = await site(owner, '<h1>v1</h1>')
    await site(owner, '<h1>v2</h1>', page.slug)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })

    expect((await files(await call(`/api/artifacts/${page.slug}/download?version=1`, { cookie: owner.cookie })))['index.html'].toString()).toBe('<h1>v1</h1>')
    expect((await files(await call(`/api/artifacts/${page.slug}/download`, { cookie: viewer.cookie })))['index.html'].toString()).toBe('<h1>v2</h1>')
    expect((await call(`/api/artifacts/${page.slug}/download?version=1`, { cookie: viewer.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download?version=3`, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download?version=abc`, { cookie: owner.cookie })).status).toBe(404)
  })

  it('a restricted page is not found without access', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const page = await site(owner, '<h1>secret</h1>')
    expect((await call(`/api/artifacts/${page.slug}/download`)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/download`, { cookie: stranger.cookie })).status).toBe(404)
    expect((await call('/api/artifacts/doesnotexist/download', { cookie: owner.cookie })).status).toBe(404)
  })

  it('download_artifact gives a link that works without a session, only while the person has access', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const editor = await createUser({ email: 'editor@example.com' })
    const page = await site(owner, '<h1>v1</h1>')
    await site(owner, '<h1>v2</h1>', page.slug)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: editor.email, role: 'editor' })
    const token = (await connectAgent(editor)).access_token

    const res = await callTool(token, 'download_artifact', { artifact_id: page.slug, version: 1 })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Version 1 of "Signups by week": index.html and 2 more files.')
    const link = res.text.match(/Download: (\S+)/)![1]
    expect(link.startsWith(`http://localhost:5177/api/artifacts/${page.slug}/download?version=1&token=`)).toBe(true)
    const path = link.replace('http://localhost:5177', '')
    expect((await files(await call(path)))['index.html'].toString()).toBe('<h1>v1</h1>')

    // The token is for that version only
    expect((await call(path.replace('version=1', 'version=2'))).status).toBe(404)
    expect((await call(`${path.slice(0, -4)}AAAA`)).status).toBe(404)

    // Access is checked again when the link is used
    await db.delete(schema.artifactShares)
    expect((await call(path)).status).toBe(404)
  })

  it('download_artifact follows the same access rules', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    const page = await site(owner, '<h1>v1</h1>')
    await site(owner, '<h1>v2</h1>', page.slug)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })
    const viewerToken = (await connectAgent(viewer)).access_token
    const strangerToken = (await connectAgent(stranger)).access_token

    expect((await callTool(viewerToken, 'download_artifact', { artifact_id: page.slug })).text).toContain('Version 2 of')
    expect(await callTool(viewerToken, 'download_artifact', { artifact_id: page.slug, version: 1 })).toMatchObject({ isError: true })
    expect(await callTool(strangerToken, 'download_artifact', { artifact_id: page.slug })).toMatchObject({
      isError: true,
      text: `No page you can open has the id "${page.slug}".`,
    })
    const ownerToken = (await connectAgent(owner)).access_token
    expect(await callTool(ownerToken, 'download_artifact', { artifact_id: page.slug, version: 9 })).toMatchObject({
      isError: true,
      text: '"Signups by week" has no version 9.',
    })
  })
})
