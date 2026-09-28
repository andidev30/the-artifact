import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sha256 } from '../../src/files.js'
import { createToken } from '../../src/tokens.js'
import { call, callTool, connectAgent, createUser, type TestUser } from './helpers.js'

const HTML = '<!doctype html><link rel="stylesheet" href="css/site.css"><script src="app.js"></script><h1>Dashboard</h1>'
const FILES = [
  { path: 'css/site.css', content: 'body { color: red }' },
  { path: 'app.js', content: 'fetch("data.json")' },
  { path: 'data.json', content: '{"visitors":1}' },
  { path: 'old.txt', content: 'left over' },
]

afterEach(() => {
  env.selfHosted = false
  env.workspaceQuota = { pages: null, versions: null, bytes: null }
})

async function dashboard(owner: TestUser) {
  return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 'test-client', title: 'Dashboard', html: HTML, files: FILES })
}

async function agent() {
  const owner = await createUser()
  return { owner, token: (await connectAgent(owner)).access_token }
}

async function versions(artifactId: string) {
  return db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, artifactId)).orderBy(schema.artifactVersions.version)
}

async function fileText(user: TestUser, slug: string, version: number, path: string) {
  const res = await call(`/api/artifacts/${slug}/v/${version}/${path}`, { cookie: user.cookie })
  return { status: res.status, text: await res.text() }
}

async function paths(versionId: string) {
  const rows = await db.select({ path: schema.artifactFiles.path }).from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, versionId))
  return rows.map((r) => r.path).sort()
}

describe('update_files', () => {
  it('replaces one file of a page and keeps the others, as a new version', async () => {
    const { owner, token } = await agent()
    const page = await dashboard(owner)

    const res = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '{"visitors":2}' }] })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Published version 2 of "Dashboard"')
    expect(res.text).toContain('Added or replaced: data.json')
    expect(res.text).toContain('The other files are as they were in version 1.')

    const [v1, v2] = await versions(page.id)
    expect(v2).toMatchObject({ version: 2, publishedBy: owner.id, publishedWith: 'claude-code', htmlSha256: v1.htmlSha256 })
    expect(await paths(v2.id)).toEqual(['app.js', 'css/site.css', 'data.json', 'old.txt'])
    const [updated] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect(updated).toMatchObject({ currentVersion: 2, title: 'Dashboard', publishedWith: 'claude-code' })

    expect(await fileText(owner, page.slug, 2, 'data.json')).toEqual({ status: 200, text: '{"visitors":2}' })
    expect(await fileText(owner, page.slug, 2, 'css/site.css')).toEqual({ status: 200, text: 'body { color: red }' })
    expect(await fileText(owner, page.slug, 2, 'app.js')).toEqual({ status: 200, text: 'fetch("data.json")' })
    expect((await fileText(owner, page.slug, 2, '')).text).toBe(HTML)
    // The history keeps the old data
    expect(await fileText(owner, page.slug, 1, 'data.json')).toEqual({ status: 200, text: '{"visitors":1}' })
  })

  it('adds and removes files, and replaces the page itself as index.html', async () => {
    const { owner, token } = await agent()
    const page = await dashboard(owner)
    const res = await callTool(token, 'update_files', {
      artifact_id: page.slug,
      files: [
        { path: 'index.html', content: '<!doctype html><h1>New</h1>' },
        { path: 'img/dot.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
      ],
      remove: ['old.txt', './app.js'],
    })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Removed: old.txt, ./app.js')
    const [, v2] = await versions(page.id)
    expect(await paths(v2.id)).toEqual(['css/site.css', 'data.json', 'img/dot.png'])
    expect((await fileText(owner, page.slug, 2, '')).text).toBe('<!doctype html><h1>New</h1>')
    expect((await fileText(owner, page.slug, 2, 'old.txt')).status).toBe(404)
    expect((await fileText(owner, page.slug, 1, 'old.txt')).status).toBe(200)
  })

  it("refuses to remove the page itself, and changes that don't fit the page", async () => {
    const { owner, token } = await agent()
    const page = await dashboard(owner)
    const update = (args: Record<string, unknown>) => callTool(token, 'update_files', { artifact_id: page.slug, ...args })

    expect(await update({ remove: ['index.html'] })).toEqual({
      isError: true,
      text: "index.html is the page itself, so it can't be removed. Send a new index.html instead.",
    })
    expect((await update({ remove: ['nope.css'] })).text).toBe(`"nope.css" isn't a file of the current version, so it can't be removed.`)
    expect((await update({ files: [{ path: 'data.json', content: '{}' }], remove: ['data.json'] })).text).toBe(
      '"data.json" is both sent and removed. Do one or the other.',
    )
    expect((await update({})).text).toBe('Send at least one file to add or replace, or a path to remove.')
    expect((await update({ files: [{ path: 'index.html', content: '  ' }] })).text).toBe('index.html is empty.')
    expect((await update({ files: [{ path: 'run.exe', content: 'x' }] })).text).toMatch(/isn't a supported file type/)
    expect((await update({ remove: ['../x.css'] })).text).toMatch(/can't contain "\." or "\.\." segments/)
    // The page as a whole stays within the limits
    const big = 'x'.repeat(3.5 * 1024 * 1024)
    expect((await update({ files: [{ path: 'a.txt', content: big }] })).isError).toBe(false)
    expect((await update({ files: [{ path: 'b.txt', content: big }] })).isError).toBe(false)
    expect((await update({ files: [{ path: 'c.txt', content: big }] })).text).toMatch(/add up to more than 10 MB/)
    expect(await versions(page.id)).toHaveLength(3)
  })

  it('applies only on top of base_version, when given', async () => {
    const { owner, token } = await agent()
    const page = await dashboard(owner)
    const first = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '2' }], base_version: 1 })
    expect(first.isError).toBe(false)
    // A second agent that read version 1 too
    const stale = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '3' }], base_version: 1 })
    expect(stale).toEqual({
      isError: true,
      text: 'This page is at version 2, not 1: someone published a new version since. Read the current version, apply your changes to it, and send its number as base_version.',
    })
    expect(await versions(page.id)).toHaveLength(2)
    expect((await fileText(owner, page.slug, 2, 'data.json')).text).toBe('2')
  })

  it('is for people who can edit the page', async () => {
    const owner = await createUser()
    const page = await dashboard(owner)
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(schema.artifactShares).values([
      { artifactId: page.id, email: editor.email, role: 'editor' },
      { artifactId: page.id, email: viewer.email, role: 'viewer' },
    ])
    const stranger = await createUser()
    const files = [{ path: 'data.json', content: '2' }]

    for (const user of [viewer, stranger]) {
      const res = await callTool((await connectAgent(user)).access_token, 'update_files', { artifact_id: page.slug, files })
      expect(res).toEqual({ isError: true, text: `No page you can edit has the id "${page.slug}".` })
    }
    expect(await versions(page.id)).toHaveLength(1)

    const res = await callTool((await connectAgent(editor, null, 'cursor')).access_token, 'update_files', { artifact_id: page.slug, files })
    expect(res.isError).toBe(false)
    const [, v2] = await versions(page.id)
    expect(v2).toMatchObject({ publishedBy: editor.id, publishedWith: 'cursor' })
  })

  it('counts toward the workspace quota like any version', async () => {
    env.selfHosted = true
    const { owner, token } = await agent()
    const page = await dashboard(owner)
    env.workspaceQuota.versions = 2
    expect((await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '2' }] })).isError).toBe(false)
    const res = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '3' }] })
    expect(res).toEqual({ isError: true, text: expect.stringMatching(/^Your personal workspace has 2 versions of its pages, the most this server allows/) })

    // Storage counts the whole version, kept files included
    env.workspaceQuota = { pages: null, versions: null, bytes: 1 }
    const full = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'data.json', content: '3' }] })
    expect(full.text).toMatch(/^This would take your personal workspace past/)
    expect(await versions(page.id)).toHaveLength(2)
  })
})

describe('updating by direct upload', () => {
  it('uploads only the changed files and keeps the rest', async () => {
    const { owner, token } = await agent()
    const page = await dashboard(owner)
    const data = Buffer.from(`{"run":"${crypto.randomUUID()}"}`)
    const files = [{ path: 'data.json', size: data.length, sha256: sha256(data) }]

    expect((await callTool(token, 'prepare_upload', { files })).text).toBe('Include index.html, the page itself, in files.')
    const prepared = await callTool(token, 'prepare_upload', { files, update: true })
    expect(prepared.text).toContain('publish_upload with this upload_id, the same files, the artifact_id and update: true')
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const url = prepared.text.match(/^curl -fsS -T 'data.json' '([^']+)'/m)![1]
    expect((await fetch(url, { method: 'PUT', body: new Uint8Array(data) })).status).toBe(200)

    expect((await callTool(token, 'publish_upload', { upload_id: uploadId, files, artifact_id: page.slug, remove: ['old.txt'] })).text).toBe(
      'remove and base_version go with update: true.',
    )
    expect((await callTool(token, 'publish_upload', { upload_id: uploadId, files, update: true })).text).toBe('Say which page to update with artifact_id.')
    expect((await callTool(token, 'publish_upload', { upload_id: uploadId, files, artifact_id: 'nosuchpage', update: true })).text).toBe(
      'No page you can edit has the id "nosuchpage".',
    )
    const res = await callTool(token, 'publish_upload', {
      upload_id: uploadId,
      files,
      artifact_id: page.slug,
      update: true,
      remove: ['old.txt'],
      base_version: 1,
    })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Published version 2 of "Dashboard"')
    const [, v2] = await versions(page.id)
    expect(await paths(v2.id)).toEqual(['app.js', 'css/site.css', 'data.json'])
    expect((await fileText(owner, page.slug, 2, 'data.json')).text).toBe(data.toString())
    expect((await fileText(owner, page.slug, 2, 'app.js')).text).toBe('fetch("data.json")')
  })
})

describe('POST /api/publish with mode update', () => {
  async function tokenFor(user: TestUser) {
    return (await createToken({ userId: user.id, organizationId: null, name: 'Nightly job', expiresAt: null })).token
  }

  it('takes JSON with only the changed files', async () => {
    const owner = await createUser()
    const page = await dashboard(owner)
    const token = await tokenFor(owner)
    const res = await call('/api/publish', {
      bearer: token,
      json: { mode: 'update', artifact_id: page.slug, files: [{ path: 'data.json', content: '{"visitors":5}' }], remove: ['old.txt'], base_version: 1 },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: page.slug, version: 2, title: 'Dashboard' })
    const [, v2] = await versions(page.id)
    expect(v2.publishedWith).toBe('Nightly job')
    expect(await paths(v2.id)).toEqual(['app.js', 'css/site.css', 'data.json'])
    expect((await fileText(owner, page.slug, 2, 'data.json')).text).toBe('{"visitors":5}')

    // A stale base_version is a conflict
    const stale = await call('/api/publish', {
      bearer: token,
      json: { mode: 'update', artifact_id: page.slug, files: [{ path: 'data.json', content: '6' }], base_version: 1 },
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: expect.stringMatching(/^This page is at version 2, not 1/), field: 'base_version' })

    // html replaces the page itself, and a title renames it
    const entry = await call('/api/publish', { bearer: token, json: { mode: 'update', artifact_id: page.slug, html: '<h1>Two</h1>', title: 'Numbers' } })
    expect(entry.status).toBe(200)
    expect(await entry.json()).toMatchObject({ version: 3, title: 'Numbers' })
    expect((await fileText(owner, page.slug, 3, '')).text).toBe('<h1>Two</h1>')
    expect((await fileText(owner, page.slug, 3, 'data.json')).text).toBe('{"visitors":5}')
  })

  it('takes multipart form data with a remove field per path', async () => {
    const owner = await createUser()
    const page = await dashboard(owner)
    const form = new FormData()
    form.append('mode', 'update')
    form.append('artifact_id', page.slug)
    form.append('remove', 'old.txt')
    form.append('remove', 'app.js')
    form.append('data.json', new Blob(['{"visitors":9}']), 'data.json')
    const res = await app.request('/api/publish', { method: 'POST', headers: { authorization: `Bearer ${await tokenFor(owner)}` }, body: form })
    expect(res.status).toBe(200)
    const [, v2] = await versions(page.id)
    expect(await paths(v2.id)).toEqual(['css/site.css', 'data.json'])
    expect((await fileText(owner, page.slug, 2, 'data.json')).text).toBe('{"visitors":9}')
  })

  it('says what is wrong with the request', async () => {
    const owner = await createUser()
    const page = await dashboard(owner)
    const token = await tokenFor(owner)
    const post = async (json: Record<string, unknown>) => {
      const res = await call('/api/publish', { bearer: token, json })
      return { status: res.status, body: await res.json() }
    }
    expect(await post({ mode: 'update', files: [] })).toEqual({
      status: 400,
      body: { error: 'Say which page to update with artifact_id.', field: 'artifact_id' },
    })
    expect(await post({ mode: 'patch', artifact_id: page.slug })).toEqual({
      status: 400,
      body: { error: 'mode is publish (the default) or update.', field: 'mode' },
    })
    expect(await post({ title: 'X', html: '<p>x</p>', artifact_id: page.slug, remove: ['old.txt'] })).toEqual({
      status: 400,
      body: { error: 'remove and base_version go with mode update.', field: 'remove' },
    })
    expect((await post({ mode: 'update', artifact_id: page.slug, base_version: 'two' })).body.field).toBe('base_version')
    expect((await post({ mode: 'update', artifact_id: page.slug, remove: 'old.txt' })).status).toBe(200)
    expect(await post({ mode: 'update', artifact_id: page.slug, remove: ['index.html'] })).toEqual({
      status: 400,
      body: { error: "index.html is the page itself, so it can't be removed. Send a new index.html instead." },
    })

    const stranger = await createUser()
    const res = await call('/api/publish', {
      bearer: await tokenFor(stranger),
      json: { mode: 'update', artifact_id: page.slug, files: [{ path: 'data.json', content: '1' }] },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: `No page you can edit has the id "${page.slug}".` })
    expect(await versions(page.id)).toHaveLength(2)
  })
})
