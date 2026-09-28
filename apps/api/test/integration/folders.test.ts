import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, slugFrom, type TestUser } from './helpers.js'

type Row = { slug: string; title: string; folder?: { id: string; name: string } | null; mine: boolean; canEdit: boolean }
type Folder = { id: string; name: string; pages: number }

async function list(user: TestUser, params: Record<string, string> = {}) {
  const res = await call(`/api/artifacts?${new URLSearchParams(params)}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return { rows: (await res.json()) as Row[], next: res.headers.get('x-next-cursor'), total: res.headers.get('x-total-count') }
}

// Every page of the list, following the cursor
async function listAll(user: TestUser, params: Record<string, string>) {
  const seen: Row[] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const page = await list(user, { ...params, ...(cursor ? { cursor } : {}) })
    seen.push(...page.rows)
    cursor = page.next
    if (!cursor) return seen
  }
  throw new Error('The cursor never ran out')
}

async function folders(user: TestUser, workspace = 'personal') {
  const res = await call(`/api/folders?workspace=${workspace}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as Folder[]
}

async function newFolder(user: TestUser, name: string, workspace = 'personal') {
  const res = await call('/api/folders', { cookie: user.cookie, json: { workspace, name } })
  expect(res.status).toBe(201)
  return (await res.json()) as Folder
}

const fileInto = (user: TestUser, slug: string, folder: string | null) =>
  call(`/api/artifacts/${slug}`, { method: 'PATCH', cookie: user.cookie, json: { folder } })

const titles = (rows: { title: string }[]) => rows.map((r) => r.title)

async function setUpdatedAt(slug: string, at: string) {
  await db
    .update(schema.artifacts)
    .set({ updatedAt: sql`${at}::timestamptz` })
    .where(eq(schema.artifacts.slug, slug))
}

describe('gallery pagination', () => {
  it('pages through every page once, newest first, including pages updated at the same instant', async () => {
    const me = await createUser()
    const slugs: string[] = []
    for (let i = 0; i < 7; i++) slugs.push((await createPage(me, { title: `Page ${i}` })).slug)
    // Four pages share one timestamp (to the microsecond), so only the id tells them apart
    for (const slug of slugs.slice(0, 4)) await setUpdatedAt(slug, '2026-01-01T00:00:00.123456Z')
    await setUpdatedAt(slugs[4], '2026-01-01T00:00:00.123457Z')
    await setUpdatedAt(slugs[5], '2026-01-01T00:00:00.123455Z')

    const first = await list(me, { limit: '2' })
    expect(first.rows).toHaveLength(2)
    expect(first.total).toBe('7')
    expect(first.next).toBeTruthy()

    const all = await listAll(me, { limit: '2' })
    expect(all).toHaveLength(7)
    expect(new Set(all.map((r) => r.slug)).size).toBe(7)

    const expected = await db.select({ slug: schema.artifacts.slug }).from(schema.artifacts).orderBy(sql`updated_at desc, id desc`)
    expect(all.map((r) => r.slug)).toEqual(expected.map((r) => r.slug))
  })

  it('stays stable while pages are published and updated during scrolling', async () => {
    const me = await createUser()
    const pages = []
    for (let i = 0; i < 5; i++) {
      const page = await createPage(me, { title: `Page ${i}` })
      await setUpdatedAt(page.slug, `2026-01-01T00:00:0${i}.000000Z`)
      pages.push(page)
    }
    const first = await list(me, { limit: '2' })
    expect(titles(first.rows)).toEqual(['Page 4', 'Page 3'])
    expect(first.total).toBe('5')

    // A new page and a newly updated one go to the top, which the next pages don't repeat
    await createPage(me, { title: 'Brand new' })
    await call(`/api/artifacts/${pages[0].slug}`, { method: 'PATCH', cookie: me.cookie, json: { title: 'Page 0 renamed' } })

    const second = await list(me, { limit: '2', cursor: first.next! })
    expect(titles(second.rows)).toEqual(['Page 2', 'Page 1'])
    expect(second.total).toBeNull()
    // Page 0 moved to the top, so nothing is left below Page 1
    expect(second.next).toBeNull()
    const fresh = await listAll(me, { limit: '2' })
    expect(titles(fresh)).toEqual(['Page 0 renamed', 'Brand new', 'Page 4', 'Page 3', 'Page 2', 'Page 1'])
  })

  it('uses 50 by default, at most 100, and rejects a broken cursor', async () => {
    const me = await createUser()
    await Promise.all(Array.from({ length: 3 }, (_, i) => createPage(me, { title: `P${i}` })))
    const all = await list(me)
    expect(all.rows).toHaveLength(3)
    expect(all.next).toBeNull()
    expect((await list(me, { limit: '0' })).rows).toHaveLength(1)
    expect((await list(me, { limit: 'lots' })).rows).toHaveLength(3)

    const bad = await call('/api/artifacts?cursor=not-a-cursor', { cookie: me.cookie })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ field: 'cursor' })
    const forged = Buffer.from("2026-01-01T00:00:00.000000Z|x' or 1=1").toString('base64url')
    expect((await call(`/api/artifacts?cursor=${forged}`, { cookie: me.cookie })).status).toBe(400)
  })

  it('pages through pages shared with you, without their folders', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const me = await createUser({ email: 'me@example.com' })
    const folder = await newFolder(owner, 'Secret project')
    for (let i = 0; i < 3; i++) {
      const page = await createPage(owner, { title: `Shared ${i}` })
      await fileInto(owner, page.slug, folder.id)
      await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'me@example.com', notify: false } })
    }
    const first = await list(me, { workspace: 'shared', limit: '2' })
    expect(first.total).toBe('3')
    const all = await listAll(me, { workspace: 'shared', limit: '2' })
    expect(titles(all).sort()).toEqual(['Shared 0', 'Shared 1', 'Shared 2'])
    for (const row of all) expect(row).not.toHaveProperty('folder')
    expect(JSON.stringify(all)).not.toContain('Secret project')
  })
})

describe('gallery search', () => {
  it('matches titles ignoring case, takes % and _ literally, and counts the matches', async () => {
    const me = await createUser()
    await createPage(me, { title: 'Quarterly Revenue' })
    await createPage(me, { title: 'revenue by region' })
    await createPage(me, { title: 'Signups' })
    await createPage(me, { title: '100% done' })

    const found = await list(me, { q: 'REVENUE' })
    expect(titles(found.rows).sort()).toEqual(['Quarterly Revenue', 'revenue by region'])
    expect(found.total).toBe('2')
    expect(titles((await list(me, { q: '%' })).rows)).toEqual(['100% done'])
    expect((await list(me, { q: '_' })).rows).toEqual([])
  })

  it('combines with a folder and with the shared tab', async () => {
    const me = await createUser({ email: 'me@example.com' })
    const owner = await createUser()
    const reports = await newFolder(me, 'Reports')
    const inFolder = await createPage(me, { title: 'Revenue report' })
    await createPage(me, { title: 'Revenue draft' })
    await fileInto(me, inFolder.slug, reports.id)
    const shared = await createPage(owner, { title: 'Revenue from a friend' })
    await call(`/api/artifacts/${shared.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'me@example.com', notify: false } })

    expect(titles((await list(me, { q: 'revenue', folder: reports.id })).rows)).toEqual(['Revenue report'])
    expect(titles((await list(me, { q: 'revenue', folder: 'none' })).rows)).toEqual(['Revenue draft'])
    expect(titles((await list(me, { workspace: 'shared', q: 'friend' })).rows)).toEqual(['Revenue from a friend'])
  })
})

describe('folders', () => {
  it('are created, listed by name with their pages, renamed and deleted', async () => {
    const me = await createUser()
    const b = await newFolder(me, '  Beta   launch ')
    expect(b.name).toBe('Beta launch')
    const a = await newFolder(me, 'alpha')
    const page = await createPage(me, { title: 'Chart' })
    const res = await fileInto(me, page.slug, a.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ folder: { id: a.id, name: 'alpha' } })

    expect(await folders(me)).toEqual([
      { id: a.id, name: 'alpha', pages: 1 },
      { id: b.id, name: 'Beta launch', pages: 0 },
    ])
    expect((await list(me)).rows[0].folder).toEqual({ id: a.id, name: 'alpha' })
    expect(titles((await list(me, { folder: a.id })).rows)).toEqual(['Chart'])
    expect((await list(me, { folder: 'none' })).rows).toEqual([])

    const renamed = await call(`/api/folders/${a.id}`, { method: 'PATCH', cookie: me.cookie, json: { name: 'Alpha' } })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ id: a.id, name: 'Alpha' })

    expect((await call(`/api/folders/${a.id}`, { method: 'DELETE', cookie: me.cookie })).status).toBe(204)
    // The page stays, in no folder
    const after = await list(me, { folder: 'none' })
    expect(titles(after.rows)).toEqual(['Chart'])
    expect(after.rows[0].folder).toBeNull()
    expect((await call(`/api/artifacts?folder=${a.id}`, { cookie: me.cookie })).status).toBe(404)
  })

  it('keeps names unique in a workspace whatever their case, and checks them', async () => {
    const me = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    const reports = await newFolder(me, 'Reports')
    const dup = await call('/api/folders', { cookie: me.cookie, json: { workspace: 'personal', name: 'REPORTS' } })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'There is already a folder called “REPORTS”.', field: 'name' })
    // The same name is fine in another workspace
    await newFolder(me, 'Reports', org.id)

    const other = await newFolder(me, 'Other')
    expect((await call(`/api/folders/${other.id}`, { method: 'PATCH', cookie: me.cookie, json: { name: 'reports' } })).status).toBe(409)
    // Changing only the case of its own name is fine
    expect((await call(`/api/folders/${reports.id}`, { method: 'PATCH', cookie: me.cookie, json: { name: 'REPORTS' } })).status).toBe(200)

    for (const name of ['', '   ', 'x'.repeat(81), 42]) {
      const res = await call('/api/folders', { cookie: me.cookie, json: { workspace: 'personal', name } })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'name' })
    }
  })

  it('are only for people in the workspace', async () => {
    const owner = await createUser()
    const member = await createUser()
    const outsider = await createUser()
    const org = await createOrg(owner, 'Acme', 'acme')
    await addMember(org.id, member, 'member')
    const orgFolder = await newFolder(owner, 'Team', org.id)
    const personal = await newFolder(owner, 'Mine')

    // Any member organizes the organization's folders
    expect((await folders(member, org.id)).map((f) => f.name)).toEqual(['Team'])
    expect((await call(`/api/folders/${orgFolder.id}`, { method: 'PATCH', cookie: member.cookie, json: { name: 'Team pages' } })).status).toBe(200)
    const byMember = await newFolder(member, 'From a member', org.id)
    expect((await call(`/api/folders/${byMember.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)

    // Outsiders and other people's personal folders look missing
    expect((await call(`/api/folders?workspace=${org.id}`, { cookie: outsider.cookie })).status).toBe(404)
    expect((await call('/api/folders', { cookie: outsider.cookie, json: { workspace: org.id, name: 'Sneaky' } })).status).toBe(404)
    for (const id of [orgFolder.id, personal.id]) {
      expect((await call(`/api/folders/${id}`, { method: 'PATCH', cookie: outsider.cookie, json: { name: 'Mine now' } })).status).toBe(404)
      expect((await call(`/api/folders/${id}`, { method: 'DELETE', cookie: outsider.cookie })).status).toBe(404)
    }
    expect((await call(`/api/folders/${personal.id}`, { method: 'DELETE', cookie: member.cookie })).status).toBe(404)
    expect((await call('/api/folders/not-a-uuid', { method: 'DELETE', cookie: owner.cookie })).status).toBe(404)
    expect((await call('/api/folders?workspace=not-a-uuid', { cookie: owner.cookie })).status).toBe(404)
    expect(await folders(outsider)).toEqual([])
    // A folder of another workspace isn't a filter here
    expect((await call(`/api/artifacts?workspace=personal&folder=${orgFolder.id}`, { cookie: owner.cookie })).status).toBe(404)
  })

  it('files pages only into folders of their own workspace, for people who can edit them there', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const admin = await createUser()
    const member = await createUser()
    const friend = await createUser({ email: 'friend@example.com' })
    const org = await createOrg(owner, 'Acme', 'acme')
    await addMember(org.id, admin, 'admin')
    await addMember(org.id, member, 'member')
    const team = await newFolder(owner, 'Team', org.id)
    const personal = await newFolder(owner, 'Mine')
    const orgPage = await createPage(owner, { title: 'Team page', organizationId: org.id, visibility: 'organization' })
    const myPage = await createPage(owner, { title: 'Personal page' })

    // Not across workspaces
    expect((await fileInto(owner, orgPage.slug, personal.id)).status).toBe(404)
    expect((await fileInto(owner, myPage.slug, team.id)).status).toBe(404)
    expect((await fileInto(owner, myPage.slug, 'not-a-uuid')).status).toBe(404)

    // A member who can only view it can't move it; an organization admin, who edits every page, can
    expect((await fileInto(member, orgPage.slug, team.id)).status).toBe(404)
    expect((await fileInto(admin, orgPage.slug, team.id)).status).toBe(200)
    const own = await createPage(member, { title: 'Member page', organizationId: org.id })
    expect((await fileInto(member, own.slug, team.id)).status).toBe(200)

    // An editor from outside the workspace can edit the page but not file it
    await call(`/api/artifacts/${myPage.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'friend@example.com', role: 'editor', notify: false } })
    const friendFolder = await newFolder(friend, 'Friend folder')
    expect((await fileInto(friend, myPage.slug, personal.id)).status).toBe(404)
    expect((await fileInto(friend, myPage.slug, friendFolder.id)).status).toBe(404)
    expect((await fileInto(friend, myPage.slug, null)).status).toBe(404)
    expect((await call(`/api/artifacts/${myPage.slug}`, { method: 'PATCH', cookie: friend.cookie, json: { title: 'Renamed by a friend' } })).status).toBe(200)
  })

  it('never change who can open a page', async () => {
    const me = await createUser()
    const mate = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    await addMember(org.id, mate, 'member')
    const folder = await newFolder(mate, 'Shared stuff', org.id)
    const secret = await createPage(me, { title: 'My draft', organizationId: org.id, visibility: 'private' })
    const open = await createPage(me, { title: 'Open page', organizationId: org.id, visibility: 'organization' })
    const [before] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, secret.id))
    expect((await fileInto(me, secret.slug, folder.id)).status).toBe(200)
    expect((await fileInto(me, open.slug, folder.id)).status).toBe(200)

    const [after] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, secret.id))
    expect(after.visibility).toBe('private')
    // Filing doesn't count as updating the page, so the gallery keeps its order
    expect(after.updatedAt).toEqual(before.updatedAt)

    // The teammate who made the folder still can't open, list or count the private page in it
    expect((await call(`/api/artifacts/${secret.slug}`, { cookie: mate.cookie })).status).toBe(404)
    expect(titles((await list(mate, { workspace: org.id, folder: folder.id })).rows)).toEqual(['Open page'])
    expect(await folders(mate, org.id)).toEqual([{ id: folder.id, name: 'Shared stuff', pages: 1 }])
    expect(await folders(me, org.id)).toEqual([{ id: folder.id, name: 'Shared stuff', pages: 2 }])

    // Deleting the folder leaves both pages as they were
    expect((await call(`/api/folders/${folder.id}`, { method: 'DELETE', cookie: mate.cookie })).status).toBe(204)
    const pages = await db.select().from(schema.artifacts)
    expect(pages.map((p) => [p.title, p.visibility, p.folderId]).sort()).toEqual([
      ['My draft', 'private', null],
      ['Open page', 'organization', null],
    ])
  })

  it('go with their workspace', async () => {
    const me = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    await newFolder(me, 'Team', org.id)
    await newFolder(me, 'Mine')
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id))
    expect((await db.select().from(schema.folders)).map((f) => f.name)).toEqual(['Mine'])
    await db.delete(schema.users).where(eq(schema.users.id, me.id))
    expect(await db.select().from(schema.folders)).toEqual([])
  })
})

describe('folders over MCP', () => {
  it('publishes into a folder by name, creating it once', async () => {
    const me = await createUser()
    const { access_token: token } = await connectAgent(me)
    const first = await callTool(token, 'publish_artifact', { title: 'Chart', html: '<h1>1</h1>', folder: 'Reports' })
    expect(first.isError).toBe(false)
    expect(first.text).toContain('Folder: Reports')
    const second = await callTool(token, 'publish_artifact', { title: 'Table', html: '<h1>2</h1>', folder: 'reports' })
    expect(second.text).toContain('Folder: Reports')
    await callTool(token, 'publish_artifact', { title: 'Loose', html: '<h1>3</h1>' })

    const [folder] = await folders(me)
    expect(folder).toMatchObject({ name: 'Reports', pages: 2 })

    // A new version keeps the folder unless folder is passed; an empty one takes the page out
    const slug = slugFrom(first.text)
    expect((await callTool(token, 'publish_artifact', { title: 'Chart', html: '<h1>1b</h1>', artifact_id: slug })).text).toContain('Folder: Reports')
    const out = await callTool(token, 'publish_artifact', { title: 'Chart', html: '<h1>1c</h1>', artifact_id: slug, folder: '' })
    expect(out.text).not.toContain('Folder:')
    expect((await folders(me))[0].pages).toBe(1)

    const tooLong = await callTool(token, 'publish_artifact', { title: 'X', html: 'x', folder: 'x'.repeat(81) })
    expect(tooLong.isError).toBe(true)
    expect(await db.select().from(schema.artifacts)).toHaveLength(3)
  })

  it('lists folders, filters, searches and pages through list_artifacts', async () => {
    const me = await createUser()
    const { access_token: token } = await connectAgent(me)
    for (let i = 0; i < 3; i++) await callTool(token, 'publish_artifact', { title: `Report ${i}`, html: 'x', folder: 'Reports' })
    await callTool(token, 'publish_artifact', { title: 'Sketch', html: 'x' })

    expect((await callTool(token, 'list_folders', {})).text).toBe('- Reports (3 pages)')

    const inFolder = await callTool(token, 'list_artifacts', { folder: 'REPORTS', limit: 2 })
    expect(inFolder.text).toContain('3 pages match; the 2 most recently updated')
    expect(inFolder.text).toContain('folder: Reports')
    const cursor = inFolder.text.match(/cursor: (\S+)$/)?.[1]
    expect(cursor).toBeTruthy()
    const rest = await callTool(token, 'list_artifacts', { folder: 'Reports', limit: 2, cursor })
    expect(rest.text.match(/Report \d/g)).toHaveLength(1)
    expect(rest.text).not.toContain('cursor:')

    expect((await callTool(token, 'list_artifacts', { folder: '' })).text).toMatch(/^- Sketch/)
    expect((await callTool(token, 'list_artifacts', { query: 'sket' })).text).toMatch(/^- Sketch/)
    expect((await callTool(token, 'list_artifacts', { folder: 'Nope' })).isError).toBe(true)
    expect((await callTool(token, 'list_artifacts', { cursor: 'broken' })).isError).toBe(true)
  })

  it('moves pages with move_artifact, only within the connected workspace', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const friend = await createUser({ email: 'friend@example.com' })
    const { access_token: token } = await connectAgent(owner)
    const { access_token: friendToken } = await connectAgent(friend)
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Plan', html: 'x' })).text)

    const moved = await callTool(token, 'move_artifact', { artifact_id: slug, folder: 'Plans' })
    expect(moved.text).toBe(`Moved "Plan" to the folder "Plans".\nLink: http://localhost:5177/a/${slug}`)
    expect((await folders(owner))[0]).toMatchObject({ name: 'Plans', pages: 1 })
    expect((await callTool(token, 'move_artifact', { artifact_id: slug, folder: ' ' })).text).toContain('is in no folder now')

    // A friend who can edit the page, connected to their own workspace, can't file it or create folders by publishing
    await call(`/api/artifacts/${slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'friend@example.com', role: 'editor', notify: false } })
    expect((await callTool(friendToken, 'move_artifact', { artifact_id: slug, folder: 'Mine' })).isError).toBe(true)
    const republish = await callTool(friendToken, 'publish_artifact', { title: 'Plan', html: 'y', artifact_id: slug, folder: 'Mine' })
    expect(republish.isError).toBe(true)
    expect(republish.text).toMatch(/another workspace/)
    const [page] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
    expect(page.currentVersion).toBe(1)
    expect(await db.select().from(schema.folders).where(eq(schema.folders.ownerId, friend.id))).toEqual([])
    // Without folder, the friend's new version is fine
    expect((await callTool(friendToken, 'publish_artifact', { title: 'Plan', html: 'y', artifact_id: slug })).isError).toBe(false)
    expect((await callTool(friendToken, 'move_artifact', { artifact_id: 'nope', folder: 'x' })).isError).toBe(true)
  })

  it('files organization pages into the organization’s folders', async () => {
    const me = await createUser()
    const mate = await createUser()
    const org = await createOrg(me, 'Acme', 'acme')
    await addMember(org.id, mate, 'member')
    const { access_token: token } = await connectAgent(me, org.id)
    await callTool(token, 'publish_artifact', { title: 'Roadmap', html: 'x', folder: 'Product', visibility: 'organization' })
    expect(await folders(mate, org.id)).toEqual([expect.objectContaining({ name: 'Product', pages: 1 })])
    expect(await folders(me)).toEqual([])
  })
})
