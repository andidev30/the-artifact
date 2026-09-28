import { describe, expect, it } from 'vitest'
import { getVersion, publish } from '../../src/artifacts.js'
import { compareVersions, MAX_DIFF_EDITS, MAX_DIFF_FILE_BYTES } from '../../src/compare.js'
import { db, schema } from '../../src/db/index.js'
import type { FileInput } from '../../src/files.js'
import { call, callTool, connectAgent, createUser, type TestUser } from './helpers.js'

// A 1x1 PNG, and another one byte different
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG2 = Buffer.concat([PNG, Buffer.from([0])])

async function site(owner: TestUser, html: string, files: FileInput[], slug?: string) {
  return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 'test-client', title: 'Signups', html, files, slug })
}

const png = (content: Buffer, path = 'img/dot.png'): FileInput => ({ path, content: content.toString('base64'), encoding: 'base64' })

async function compare(user: TestUser, slug: string, query: string) {
  return call(`/api/artifacts/${slug}/compare?${query}`, { cookie: user.cookie })
}

describe('comparing two versions', () => {
  it('lists added, removed and changed files with a diff of the text ones', async () => {
    const owner = await createUser()
    const page = await site(owner, '<h1>Signups</h1>\n<p>Draft</p>\n', [
      { path: 'css/site.css', content: 'body { color: red }\n' },
      { path: 'old.js', content: 'console.log(1)\n' },
      { path: 'same.txt', content: 'unchanged\n' },
      png(PNG),
    ])
    await site(
      owner,
      '<h1>Signups</h1>\n<p>Final</p>\n',
      [
        { path: 'css/site.css', content: 'body { color: blue }\n' },
        { path: 'new.json', content: '{"a":1}' },
        { path: 'same.txt', content: 'unchanged\n' },
        png(PNG2),
      ],
      page.slug,
    )

    const res = await compare(owner, page.slug, 'from=1&to=2')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.json()
    expect(body).toMatchObject({ from: 1, to: 2, unchanged: 1 })
    expect(body.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ['index.html', 'changed'],
      ['css/site.css', 'changed'],
      ['img/dot.png', 'changed'],
      ['new.json', 'added'],
      ['old.js', 'removed'],
    ])
    const [html, css, image, added, removed] = body.files
    expect(html).toMatchObject({ additions: 1, deletions: 1, omitted: null, from: { contentType: 'text/html; charset=utf-8' } })
    expect(html.diff).toBe('--- a/index.html\n+++ b/index.html\n@@ -1,2 +1,2 @@\n <h1>Signups</h1>\n-<p>Draft</p>\n+<p>Final</p>\n')
    expect(css.diff).toContain('-body { color: red }\n+body { color: blue }\n')
    expect(image).toMatchObject({ diff: null, omitted: 'binary', from: { size: PNG.length, contentType: 'image/png' }, to: { size: PNG2.length } })
    expect(added).toMatchObject({ from: null, to: { size: 7, contentType: 'application/json; charset=utf-8' }, additions: 1, deletions: 0 })
    expect(added.diff).toBe('--- /dev/null\n+++ b/new.json\n@@ -0,0 +1 @@\n+{"a":1}\n\\ No newline at end of file\n')
    expect(removed).toMatchObject({ to: null, diff: '--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-console.log(1)\n' })

    // Either order; the same version has no changes
    const reverse = await (await compare(owner, page.slug, 'from=2&to=1')).json()
    expect(reverse.files.find((f: { path: string }) => f.path === 'new.json').status).toBe('removed')
    expect(await (await compare(owner, page.slug, 'from=2&to=2')).json()).toEqual({ from: 2, to: 2, files: [], unchanged: 5 })
  })

  it('shows big files and files with too many changed lines without a diff', async () => {
    const owner = await createUser()
    const big = (word: string) => `${word}\n`.repeat(Math.ceil((MAX_DIFF_FILE_BYTES + 1) / (word.length + 1)))
    const lines = (word: string) => Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `${word} ${i}`).join('\n')
    const page = await site(owner, '<h1>v1</h1>', [
      { path: 'big.txt', content: big('old') },
      { path: 'many.txt', content: lines('old') },
    ])
    await site(
      owner,
      '<h1>v1</h1>',
      [
        { path: 'big.txt', content: big('new') },
        { path: 'many.txt', content: lines('new') },
      ],
      page.slug,
    )
    const body = await (await compare(owner, page.slug, 'from=1&to=2')).json()
    expect(body.files).toMatchObject([
      { path: 'big.txt', status: 'changed', diff: null, additions: null, omitted: 'large' },
      { path: 'many.txt', status: 'changed', diff: null, additions: null, omitted: 'complex' },
    ])
    expect(body.unchanged).toBe(1)
  })

  it('stops diffing once the comparison is as big as it may be', async () => {
    const owner = await createUser()
    const files = (word: string) => ['a', 'b', 'c'].map((name) => ({ path: `${name}.txt`, content: `${word} ${name}\n`.repeat(100) }))
    const page = await site(owner, '<h1>v1</h1>', files('old'))
    await site(owner, '<h1>v1</h1>', files('new'), page.slug)
    const [from, to] = await Promise.all([getVersion(page, 1), getVersion(page, 2)])

    const byOutput = await compareVersions(from!, to!, { input: 1_000_000, output: 2000 })
    expect(byOutput.files.map((f) => f.omitted)).toEqual([null, 'budget', 'budget'])
    expect(byOutput.files[1]).toMatchObject({ additions: 100, deletions: 100, diff: null })

    const byInput = await compareVersions(from!, to!, { input: 2000, output: 1_000_000 })
    expect(byInput.files.map((f) => f.omitted)).toEqual([null, 'budget', 'budget'])
  })

  it('is for editors only, and anything else is not found', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const editor = await createUser({ email: 'editor@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    const page = await site(owner, '<h1>v1</h1>', [])
    await site(owner, '<h1>v2</h1>', [], page.slug)
    await db.insert(schema.artifactShares).values([
      { artifactId: page.id, email: editor.email, role: 'editor' },
      { artifactId: page.id, email: viewer.email, role: 'viewer' },
    ])
    await db.update(schema.artifacts).set({ visibility: 'link' })

    expect((await compare(editor, page.slug, 'from=1&to=2')).status).toBe(200)
    expect((await compare(viewer, page.slug, 'from=1&to=2')).status).toBe(404)
    expect((await compare(stranger, page.slug, 'from=1&to=2')).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/compare?from=1&to=2`)).status).toBe(401)
    for (const query of ['from=1&to=3', 'from=0&to=2', 'from=1.0&to=2', 'from=1e0&to=2', 'from=%2B1&to=2', 'from=1', 'to=2', 'from=99999999999&to=1']) {
      const res = await compare(owner, page.slug, query)
      expect(res.status, query).toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found' })
    }
    expect((await compare(owner, 'doesnotexist', 'from=1&to=2')).status).toBe(404)
  })

  it('diff_versions gives agents the same comparison as text', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const page = await site(owner, '<h1>v1</h1>\n', [png(PNG)])
    await site(owner, '<h1>v2</h1>\n', [png(PNG2), { path: 'app.js', content: 'go()\n' }], page.slug)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: viewer.email, role: 'viewer' })
    const token = (await connectAgent(owner)).access_token

    const res = await callTool(token, 'diff_versions', { artifact_id: page.slug, from: 1, to: 2 })
    expect(res.isError).toBe(false)
    expect(res.text).toBe(
      [
        'Changes in "Signups" from version 1 to version 2. 3 files differ: 2 changed, 1 added, 0 removed, 0 unchanged.',
        '',
        'Changed: index.html (text/html, 12 B → 12 B, +1 -1 lines)',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>v1</h1>',
        '+<h1>v2</h1>',
        '',
        'Added: app.js (text/javascript, 5 B, +1 -0 lines)',
        '--- /dev/null',
        '+++ b/app.js',
        '@@ -0,0 +1 @@',
        '+go()',
        '',
        `Changed: img/dot.png (image/png, ${PNG.length} B → ${PNG2.length} B)`,
        'Not a text file, so there is no line diff.',
      ].join('\n'),
    )
    expect(await callTool(token, 'diff_versions', { artifact_id: page.slug, from: 1, to: 5 })).toMatchObject({
      isError: true,
      text: '"Signups" has no version 5. Call list_versions to see its versions.',
    })
    const viewerToken = (await connectAgent(viewer)).access_token
    expect(await callTool(viewerToken, 'diff_versions', { artifact_id: page.slug, from: 1, to: 2 })).toMatchObject({
      isError: true,
      text: `No page you can edit has the id "${page.slug}".`,
    })
  })
})
