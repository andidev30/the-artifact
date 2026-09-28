import { describe, expect, it } from 'vitest'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

type Row = { slug: string; title: string; tags: string[]; comments: number }

async function tag(user: TestUser, slug: string, change: { add?: unknown; remove?: unknown }) {
  return call(`/api/artifacts/${slug}/tags`, { cookie: user.cookie, method: 'PATCH', json: change })
}

async function list(user: TestUser, params: string) {
  const res = await call(`/api/artifacts?${params}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return { rows: (await res.json()) as Row[], total: res.headers.get('X-Total-Count'), next: res.headers.get('X-Next-Cursor') }
}

const titles = async (user: TestUser, params: string) => (await list(user, params)).rows.map((r) => r.title).sort()

describe('tags', () => {
  it('are added, normalized, listed on cards and on the page, and removed', async () => {
    const me = await createUser()
    const page = await createPage(me, { title: 'Report' })

    let res = await tag(me, page.slug, { add: ['  Q3 ', 'Design   Review', 'q3'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ['design review', 'q3'] })

    expect((await list(me, 'workspace=personal')).rows[0]).toMatchObject({ title: 'Report', tags: ['design review', 'q3'] })
    expect(await (await call(`/api/artifacts/${page.slug}`, { cookie: me.cookie })).json()).toMatchObject({ tags: ['design review', 'q3'] })

    res = await tag(me, page.slug, { remove: ['Q3', 'not there'], add: ['draft'] })
    expect(await res.json()).toEqual({ tags: ['design review', 'draft'] })
    // Tagging doesn't move the page in the gallery
    const updated = (await (await call(`/api/artifacts/${page.slug}`, { cookie: me.cookie })).json()).updatedAt
    expect(new Date(updated).getTime()).toBe(page.updatedAt.getTime())

    const tags = await call('/api/tags?workspace=personal', { cookie: me.cookie })
    expect(await tags.json()).toEqual([
      { tag: 'design review', pages: 1 },
      { tag: 'draft', pages: 1 },
    ])
  })

  it('are checked', async () => {
    const me = await createUser()
    const page = await createPage(me)
    const refused = async (change: { add?: unknown; remove?: unknown }, message: RegExp) => {
      const res = await tag(me, page.slug, change)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(message), field: 'tags' })
    }
    await refused({ add: [''] }, /at least one character/)
    await refused({ add: ['   '] }, /at least one character/)
    await refused({ add: ['x'.repeat(33)] }, /32 characters/)
    await refused({ add: ['a\u0000b'] }, /control characters/)
    await refused({ add: ['a,b'] }, /comma/)
    await refused({ add: [42] }, /short text/)
    await refused({ add: 'q3' }, /list/)
    // 32 characters, counted as people see them
    expect((await tag(me, page.slug, { add: ['é'.repeat(32)] })).status).toBe(200)

    const ten = Array.from({ length: 9 }, (_, i) => `t${i}`)
    expect((await tag(me, page.slug, { add: ten })).status).toBe(200)
    await refused({ add: ['one too many'] }, /up to 10 tags/)
    // Removing one makes room in the same change
    expect(await (await tag(me, page.slug, { remove: ['t0'], add: ['fits'] })).json()).toMatchObject({ tags: expect.arrayContaining(['fits']) })
  })

  it('are changed by editors only, and seen by everyone who can open the page', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const editor = await createUser({ email: 'editor@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    const page = await createPage(owner, { title: 'Shared' })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: viewer.email, role: 'viewer', notify: false } })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: editor.email, role: 'editor', notify: false } })

    expect((await tag(viewer, page.slug, { add: ['nope'] })).status).toBe(404)
    expect((await tag(stranger, page.slug, { add: ['nope'] })).status).toBe(404)
    expect((await tag(editor, page.slug, { add: ['by editor'] })).status).toBe(200)

    expect((await list(viewer, 'workspace=shared')).rows[0].tags).toEqual(['by editor'])
    expect(await titles(viewer, 'workspace=shared&tag=by%20editor')).toEqual(['Shared'])
    expect(await (await call(`/api/artifacts/${page.slug}`, { cookie: viewer.cookie })).json()).toMatchObject({ tags: ['by editor'] })
    // Someone who can't open the page learns nothing
    expect(await titles(stranger, 'workspace=shared&tag=by%20editor')).toEqual([])
  })

  it('filter the gallery, together with folders and search, with the cursor and totals', async () => {
    const me = await createUser()
    const mate = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    await addMember(org.id, mate, 'member')
    const folder = (await (await call('/api/folders', { cookie: me.cookie, json: { workspace: org.id, name: 'Reports' } })).json()) as { id: string }

    const pages = []
    for (const [title, html] of [
      ['Alpha', '<p>Budget</p>'],
      ['Beta', '<p>Budget</p>'],
      ['Gamma', '<p>Other</p>'],
      ['Delta', '<p>Budget</p>'],
    ])
      pages.push(await createPage(me, { title, html, organizationId: org.id }))
    const hidden = await createPage(mate, { title: 'Mate private', organizationId: org.id, visibility: 'private' })
    for (const p of [...pages.slice(0, 3), hidden]) await tag(p.ownerId === me.id ? me : mate, p.slug, { add: ['finance'] })
    for (const p of pages.slice(0, 2)) await call(`/api/artifacts/${p.slug}`, { cookie: me.cookie, method: 'PATCH', json: { folder: folder.id } })

    expect(await titles(me, `workspace=${org.id}&tag=finance`)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(await titles(me, `workspace=${org.id}&tag=FINANCE`)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(await titles(me, `workspace=${org.id}&tag=finance&q=budget`)).toEqual(['Alpha', 'Beta'])
    expect(await titles(me, `workspace=${org.id}&tag=finance&folder=none`)).toEqual(['Gamma'])
    expect(await titles(me, `workspace=${org.id}&tag=finance&folder=${folder.id}&q=budget`)).toEqual(['Alpha', 'Beta'])
    expect(await titles(me, `workspace=${org.id}&tag=unknown`)).toEqual([])
    expect((await call(`/api/artifacts?workspace=${org.id}&tag=${'x'.repeat(40)}`, { cookie: me.cookie })).status).toBe(400)

    const first = await list(me, `workspace=${org.id}&tag=finance&limit=2`)
    expect(first.total).toBe('3')
    expect(first.rows.map((r) => r.title)).toEqual(['Gamma', 'Beta'])
    const second = await list(me, `workspace=${org.id}&tag=finance&limit=2&cursor=${first.next}`)
    expect(second.rows.map((r) => r.title)).toEqual(['Alpha'])
    expect(second.next).toBeNull()

    // The workspace's tags count only the pages this person sees
    expect(await (await call(`/api/tags?workspace=${org.id}`, { cookie: me.cookie })).json()).toEqual([{ tag: 'finance', pages: 3 }])
    expect(await (await call(`/api/tags?workspace=${org.id}`, { cookie: mate.cookie })).json()).toEqual([{ tag: 'finance', pages: 4 }])
    const outsider = await createUser()
    expect((await call(`/api/tags?workspace=${org.id}`, { cookie: outsider.cookie })).status).toBe(404)
  })

  it("aren't shown, filtered on or counted for listed link pages a member can't open, nor their comment counts", async () => {
    const me = await createUser({ email: 'me@example.com' })
    const mate = await createUser({ email: 'mate@example.com' })
    const admin = await createUser({ email: 'admin@example.com' })
    const org = await createOrg(mate, 'Acme', 'acme')
    await addMember(org.id, me, 'member')
    await addMember(org.id, admin, 'admin')
    const open = await createPage(mate, { title: 'Open link', organizationId: org.id, visibility: 'link' })
    const locked = await createPage(mate, { title: 'Password link', organizationId: org.id, visibility: 'link' })
    for (const p of [open, locked]) {
      await tag(mate, p.slug, { add: ['merger'] })
      expect((await call(`/api/artifacts/${p.slug}/comments`, { cookie: mate.cookie, json: { body: 'Looks good' } })).status).toBe(201)
    }
    expect((await call(`/api/artifacts/${locked.slug}`, { cookie: mate.cookie, method: 'PATCH', json: { linkPassword: 'a long password' } })).status).toBe(200)

    // Its title is listed as before
    const rows = (await list(me, `workspace=${org.id}`)).rows
    expect(rows.map((r) => [r.title, r.tags, r.comments]).sort()).toEqual([
      ['Open link', ['merger'], 1],
      ['Password link', [], 0],
    ])
    expect(await titles(me, `workspace=${org.id}&tag=merger`)).toEqual(['Open link'])
    expect((await list(me, `workspace=${org.id}&tag=merger`)).total).toBe('1')
    expect(await (await call(`/api/tags?workspace=${org.id}`, { cookie: me.cookie })).json()).toEqual([{ tag: 'merger', pages: 1 }])
    const listed = await callTool((await connectAgent(me, org.id)).access_token, 'list_artifacts', {})
    expect(listed.text).toMatch(/Open link \([^)]*tags: merger\)/)
    expect(listed.text).toMatch(/Password link \((?![^)]*tags)/)

    // Admins and the owner open it, so they see everything
    for (const user of [admin, mate]) {
      expect(await titles(user, `workspace=${org.id}&tag=merger`)).toEqual(['Open link', 'Password link'])
      expect(await (await call(`/api/tags?workspace=${org.id}`, { cookie: user.cookie })).json()).toEqual([{ tag: 'merger', pages: 2 }])
    }
  })

  it('work over MCP: tag_artifact and list_artifacts with tag', async () => {
    const me = await createUser()
    const token = (await connectAgent(me)).access_token
    const page = await createPage(me, { title: 'Launch plan', html: '<p>Rocket</p>' })
    await createPage(me, { title: 'Other' })

    let res = await callTool(token, 'tag_artifact', { artifact_id: page.slug, add: ['Launch', 'q4'] })
    expect(res).toMatchObject({ isError: false })
    expect(res.text).toContain('has the tags: launch, q4')
    res = await callTool(token, 'tag_artifact', { artifact_id: page.slug, remove: ['q4'] })
    expect(res.text).toContain('has the tags: launch')
    expect((await callTool(token, 'tag_artifact', { artifact_id: page.slug, add: ['a,b'] })).isError).toBe(true)
    expect((await callTool(token, 'tag_artifact', { artifact_id: page.slug })).isError).toBe(true)
    expect((await callTool(token, 'tag_artifact', { artifact_id: 'nosuchpage', add: ['x'] })).isError).toBe(true)

    const listed = await callTool(token, 'list_artifacts', { tag: 'launch' })
    expect(listed.text).toContain('Launch plan')
    expect(listed.text).toContain('tags: launch')
    expect(listed.text).not.toContain('Other')
    expect((await callTool(token, 'list_artifacts', { tag: 'launch', query: 'rocket' })).text).toContain('Launch plan')
    expect((await callTool(token, 'list_artifacts', { tag: 'nothing' })).text).toBe('No pages match.')
    expect((await callTool(token, 'get_artifact', { artifact_id: page.slug })).text).toContain('Tags: launch')

    const viewer = await createUser({ email: 'viewer@example.com' })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: me.cookie, json: { emails: viewer.email, notify: false } })
    const viewerToken = (await connectAgent(viewer)).access_token
    expect((await callTool(viewerToken, 'tag_artifact', { artifact_id: page.slug, add: ['x'] })).isError).toBe(true)
  })

  it('go with the page when it is deleted', async () => {
    const me = await createUser()
    const page = await createPage(me)
    await tag(me, page.slug, { add: ['gone'] })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: me.cookie, method: 'DELETE' })).status).toBe(204)
    expect(await (await call('/api/tags?workspace=personal', { cookie: me.cookie })).json()).toEqual([])
  })
})
