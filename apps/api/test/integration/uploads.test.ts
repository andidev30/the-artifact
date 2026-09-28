import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sha256 } from '../../src/files.js'
import { sweepStorage } from '../../src/gc.js'
import { getBlob } from '../../src/storage.js'
import { addMember, call, callTool, connectAgent, createOrg, createUser, mcpRequest, slugFrom } from './helpers.js'

// Unique per run: the test bucket keeps blobs between runs, and stored content is never uploaded again
function page() {
  const id = crypto.randomUUID()
  const files: Record<string, Buffer> = {
    'index.html': Buffer.from(`<!doctype html><link rel="stylesheet" href="site.css"><img src="img/big.png"><p>${id}</p>`),
    'site.css': Buffer.from(`/* ${id} */ body { color: red }`),
    // Larger than a serverless request body may be, which is the point of uploading directly
    'img/big.png': Buffer.concat([Buffer.from(id), Buffer.alloc(5 * 1024 * 1024 - 36, 7)]),
  }
  return { files, manifest: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })) }
}

// The upload links in prepare_upload's answer, by the path they are for
function links(text: string): Map<string, string> {
  return new Map([...text.matchAll(/^curl -fsS -T '([^']+)' '([^']+)'/gm)].map((m) => [m[1], m[2]]))
}

async function put(url: string, body: Buffer) {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) })
  expect(res.status).toBe(200)
}

async function agent() {
  const owner = await createUser()
  return { owner, token: (await connectAgent(owner)).access_token }
}

describe('publishing by direct upload', () => {
  afterEach(() => {
    env.storage.publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? ''
  })

  it('makes an owner who left an organization upload again what its pages hold', async () => {
    const owner = await createUser()
    const boss = await createUser()
    const org = await createOrg(boss)
    await addMember(org.id, owner, 'member')
    const orgToken = (await connectAgent(owner, org.id)).access_token
    const { files, manifest } = page()
    const first = await callTool(orgToken, 'prepare_upload', { files: manifest })
    for (const [path, url] of links(first.text)) await put(url, files[path])
    const uploadId = first.text.match(/upload_id: ([0-9a-f]+)/)![1]
    expect((await callTool(orgToken, 'publish_upload', { title: 'Team page', upload_id: uploadId, files: manifest })).isError).toBe(false)

    const personal = (await connectAgent(owner)).access_token
    expect((await callTool(personal, 'prepare_upload', { files: manifest })).text).toContain('Already stored')
    expect((await call(`/api/organizations/${org.id}/members/${owner.id}`, { method: 'DELETE', cookie: boss.cookie })).status).toBe(200)
    const after = await callTool(personal, 'prepare_upload', { files: manifest })
    expect(after.text).not.toContain('Already stored')
    expect([...links(after.text).keys()].sort()).toEqual(['img/big.png', 'index.html', 'site.css'])
  })

  it('prepares links, takes the bytes straight to storage and publishes them', async () => {
    const { owner, token } = await agent()
    const { files, manifest } = page()
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    expect(prepared.isError).toBe(false)
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const urls = links(prepared.text)
    expect([...urls.keys()].sort()).toEqual(['img/big.png', 'index.html', 'site.css'])
    // MinIO ignores a signed checksum of the empty body; AWS S3 refuses the upload
    for (const url of urls.values()) expect(new URL(url).searchParams.has('x-amz-checksum-crc32')).toBe(false)
    for (const [path, url] of urls) await put(url, files[path])

    const res = await callTool(token, 'publish_upload', { title: 'Big page', upload_id: uploadId, files: manifest })
    expect(res).toMatchObject({ isError: false })
    expect(res.text).toContain('Files: index.html and 2 more.')
    const slug = slugFrom(res.text)
    expect(await (await call(`/api/artifacts/${slug}/v/1/`, { cookie: owner.cookie })).text()).toBe(files['index.html'].toString())
    const png = await call(`/api/artifacts/${slug}/v/1/img/big.png`, { cookie: owner.cookie })
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await png.arrayBuffer()).equals(files['img/big.png'])).toBe(true)
  })

  it('skips content that is already stored, so a new version uploads only what changed', async () => {
    const { owner, token } = await agent()
    const { files, manifest } = page()
    const first = await callTool(token, 'prepare_upload', { files: manifest })
    for (const [path, url] of links(first.text)) await put(url, files[path])
    const uploadId = first.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const slug = slugFrom((await callTool(token, 'publish_upload', { title: 'Page', upload_id: uploadId, files: manifest })).text)

    const css = Buffer.from(`/* ${crypto.randomUUID()} */`)
    const next = manifest.map((f) => (f.path === 'site.css' ? { path: f.path, size: css.length, sha256: sha256(css) } : f))
    const second = await callTool(token, 'prepare_upload', { files: next })
    expect([...links(second.text).keys()]).toEqual(['site.css'])
    expect(second.text).toContain('Already stored, no upload needed:')
    await put(links(second.text).get('site.css')!, css)
    const secondId = second.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const res = await callTool(token, 'publish_upload', { title: 'Page', upload_id: secondId, files: next, artifact_id: slug })
    expect(res.text).toContain('Published version 2 of "Page"')
    expect(await (await call(`/api/artifacts/${slug}/v/2/site.css`, { cookie: owner.cookie })).text()).toBe(css.toString())
  })

  it("doesn't reveal whether content is already stored for someone else, and asks for the bytes anyway", async () => {
    const alice = await agent()
    const { files, manifest } = page()
    const first = await callTool(alice.token, 'prepare_upload', { files: manifest })
    for (const [path, url] of links(first.text)) await put(url, files[path])
    const firstId = first.text.match(/upload_id: ([0-9a-f]+)/)![1]
    expect((await callTool(alice.token, 'publish_upload', { title: 'Page', upload_id: firstId, files: manifest })).isError).toBe(false)

    const bob = await agent()
    const prepared = await callTool(bob.token, 'prepare_upload', { files: manifest })
    expect(prepared.text).not.toContain('Already stored')
    expect([...links(prepared.text).keys()].sort()).toEqual(['img/big.png', 'index.html', 'site.css'])
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const skipped = await callTool(bob.token, 'publish_upload', { title: 'Copy', upload_id: uploadId, files: manifest })
    expect(skipped).toMatchObject({ isError: true })
    expect(skipped.text).toMatch(/wasn't uploaded/)

    for (const [path, url] of links(prepared.text)) await put(url, files[path])
    const res = await callTool(bob.token, 'publish_upload', { title: 'Copy', upload_id: uploadId, files: manifest })
    expect(res.isError).toBe(false)
    const slug = slugFrom(res.text)
    expect(await (await call(`/api/artifacts/${slug}/v/1/`, { cookie: bob.owner.cookie })).text()).toBe(files['index.html'].toString())
  })

  it('refuses bytes that are not what the manifest said, and stores nothing under that hash', async () => {
    const { token } = await agent()
    const { manifest } = page()
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    for (const [path, url] of links(prepared.text)) {
      const size = manifest.find((f) => f.path === path)!.size
      // Right size, wrong bytes
      await put(url, Buffer.alloc(size, 1))
    }
    const res = await callTool(token, 'publish_upload', { title: 'X', upload_id: uploadId, files: manifest })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/doesn't match its size and sha256/)
    expect(await db.select().from(schema.artifacts)).toEqual([])
    for (const f of manifest) expect(await getBlob(f.sha256)).toBeNull()
  })

  it('refuses a publish with files that were never uploaded', async () => {
    const { token } = await agent()
    const { files, manifest } = page()
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    await put(links(prepared.text).get('index.html')!, files['index.html'])
    const res = await callTool(token, 'publish_upload', { title: 'X', upload_id: uploadId, files: manifest })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/wasn't uploaded/)
    expect(await db.select().from(schema.artifacts)).toEqual([])

    const bad = await callTool(token, 'publish_upload', { title: 'X', upload_id: '../x', files: manifest })
    expect(bad.text).toBe('Unknown upload_id "../x". Call prepare_upload first.')
  })

  it('upload links only take the size they were made for', async () => {
    const { token } = await agent()
    const { files, manifest } = page()
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    const res = await fetch(links(prepared.text).get('site.css')!, {
      method: 'PUT',
      body: new Uint8Array(Buffer.concat([files['site.css'], Buffer.from('more')])),
    })
    expect(res.ok).toBe(false)
  })

  it('checks the manifest with the same rules as an inline publish', async () => {
    const { token } = await agent()
    const hash = sha256('x')
    const error = async (files: unknown[]) => (await callTool(token, 'prepare_upload', { files })).text
    expect(await error([{ path: 'a.css', size: 1, sha256: hash }])).toBe('Include index.html, the page itself, in files.')
    expect(await error([{ path: 'index.html', size: 1, sha256: 'abc' }])).toMatch(/needs its sha256/)
    expect(await error([{ path: 'index.html', size: 3 * 1024 * 1024, sha256: hash }])).toMatch(/larger than 2 MB/)
    expect(
      await error([
        { path: 'index.html', size: 1, sha256: hash },
        { path: '../x.css', size: 1, sha256: hash },
      ]),
    ).toMatch(/can't contain/)
    expect(
      await error([
        { path: 'index.html', size: 1, sha256: hash },
        { path: 'x.exe', size: 1, sha256: hash },
      ]),
    ).toMatch(/isn't a supported file type/)
    expect(
      await error([
        { path: 'index.html', size: 1, sha256: hash },
        { path: 'big.png', size: 6 * 1024 * 1024, sha256: hash },
      ]),
    ).toMatch(/larger than 5 MB/)
    const tooMuch = [0, 1, 2].map((i) => ({ path: `v${i}.mp4`, size: 4 * 1024 * 1024, sha256: hash }))
    expect(await error([{ path: 'index.html', size: 1, sha256: hash }, ...tooMuch])).toMatch(/add up to more than 10 MB/)
  })

  it('is not offered without a public storage endpoint', async () => {
    env.storage.publicEndpoint = ''
    const { token } = await agent()
    const res = await mcpRequest(token, 'tools/list')
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(names).toContain('publish_artifact')
    expect(names).not.toContain('prepare_upload')
    expect(names).not.toContain('publish_upload')
  })

  it('the sweep removes uploads nobody published', async () => {
    const { token } = await agent()
    const { files, manifest } = page()
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    for (const [path, url] of links(prepared.text)) await put(url, files[path])

    expect((await sweepStorage()).uploads).toBe(0)
    expect((await sweepStorage({ graceMs: 0 })).uploads).toBeGreaterThanOrEqual(3)
    const res = await callTool(token, 'publish_upload', { title: 'X', upload_id: uploadId, files: manifest })
    expect(res.text).toMatch(/wasn't uploaded/)
    expect(await db.select().from(schema.artifacts).where(eq(schema.artifacts.title, 'X'))).toEqual([])
  })
})
