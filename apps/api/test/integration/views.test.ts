import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { deleteOldViews, forgetRecentViews } from '../../src/views.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

type Views = {
  total: number
  versions: { version: number; views: number }[]
  people: { name: string | null; email: string; visits: number; lastViewedAt: string; lastVersion: number }[]
  morePeople: boolean
  keptDays: number
}

// What a browser does when the viewer's frame loads a version: a navigation, redirected under a link
// token when the page needs to know who is looking
async function open(page: Artifact, version: number, opts: { viewer?: TestUser; agent?: string } = {}) {
  const headers = { 'sec-fetch-dest': 'iframe', 'user-agent': opts.agent ?? 'test-browser' }
  const base = `/api/artifacts/${page.slug}/v/${version}/`
  let res = await call(base, { cookie: opts.viewer?.cookie, headers })
  if (res.status === 302) res = await call(res.headers.get('location')!, { headers })
  expect(res.status).toBe(200)
}

async function views(page: Artifact, user: TestUser) {
  const res = await call(`/api/artifacts/${page.slug}/views`, { cookie: user.cookie })
  return { status: res.status, body: (await res.json()) as Views }
}

async function orgPage() {
  const owner = await createUser({ name: 'Owner' })
  const org = await createOrg(owner)
  const member = await createUser({ name: 'Mia Member' })
  await addMember(org.id, member, 'member')
  const page = await createPage(owner, { organizationId: org.id, visibility: 'organization' })
  return { owner, org, member, page }
}

describe('page views', () => {
  beforeEach(() => forgetRecentViews())
  afterEach(() => {
    env.cronSecret = ''
  })

  it('records who opened an organization page, once per person within 30 minutes', async () => {
    const { owner, member, page } = await orgPage()
    await open(page, 1, { viewer: member })
    await open(page, 1, { viewer: member })
    // Another server process, which hasn't seen the first visit, still doesn't count it twice
    forgetRecentViews()
    await open(page, 1, { viewer: member })
    // The owner's own visits don't count
    await open(page, 1, { viewer: owner })

    const { status, body } = await views(page, owner)
    expect(status).toBe(200)
    expect(body).toMatchObject({ total: 1, versions: [{ version: 1, views: 1 }], morePeople: false, keptDays: 90 })
    expect(body.people).toEqual([{ name: 'Mia Member', email: member.email, visits: 1, lastViewedAt: expect.any(String), lastVersion: 1 }])
  })

  it('records pages shared with specific people', async () => {
    const owner = await createUser()
    const guest = await createUser()
    const page = await createPage(owner)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: guest.email, role: 'viewer' })
    await open(page, 1, { viewer: guest })
    const { body } = await views(page, owner)
    expect(body.total).toBe(1)
    expect(body.people.map((p) => p.email)).toEqual([guest.email])
  })

  it('counts visits through a shared link without recording who', async () => {
    const owner = await createUser()
    const reader = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    await open(page, 1, { agent: 'browser-a' })
    await open(page, 1, { agent: 'browser-a' })
    await open(page, 1, { agent: 'browser-b' })
    // Signed in or not, a link visit stays anonymous
    await open(page, 1, { viewer: reader, agent: 'browser-c' })

    const { body } = await views(page, owner)
    expect(body.total).toBe(3)
    expect(body.people).toEqual([])
    expect(await db.select().from(schema.artifactViews)).toEqual([])
  })

  it('counts each version, and only the page itself, not its files or other requests', async () => {
    const { owner, member, page } = await orgPage()
    await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: page.organizationId,
      clientName: 'test-client',
      title: 'Test page',
      slug: page.slug,
      html: '<!doctype html><link rel="stylesheet" href="site.css"><h1>Two</h1>',
      files: [{ path: 'site.css', content: 'h1 { color: red }' }],
    })
    await open(page, 2, { viewer: member })
    // A script's fetch, a stylesheet and a HEAD request aren't someone opening the page
    await call(`/api/artifacts/${page.slug}/v/2/`, { cookie: member.cookie })
    await call(`/api/artifacts/${page.slug}/v/2/site.css`, { cookie: member.cookie, headers: { 'sec-fetch-dest': 'style' } })

    // Older versions are for editors; an organization admin opens one
    const admin = await createUser({ name: 'Ada Admin' })
    await addMember(page.organizationId!, admin, 'admin')
    await open(page, 1, { viewer: admin })

    const { body } = await views(page, owner)
    expect(body.total).toBe(2)
    expect(body.versions).toEqual([
      { version: 2, views: 1 },
      { version: 1, views: 1 },
    ])
    expect(body.people.map((p) => [p.name, p.lastVersion])).toEqual([
      ['Ada Admin', 1],
      ['Mia Member', 2],
    ])
  })

  it('shows views only to people who can manage the page', async () => {
    const { owner, org, member, page } = await orgPage()
    const outsider = await createUser()
    const admin = await createUser()
    await addMember(org.id, admin, 'admin')
    await open(page, 1, { viewer: member })

    expect((await views(page, member)).status).toBe(404)
    expect((await views(page, outsider)).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/views`)).status).toBe(401)
    expect((await views(page, admin)).body.total).toBe(1)

    const details = async (u: TestUser) => (await (await call(`/api/artifacts/${page.slug}`, { cookie: u.cookie })).json()).views
    expect(await details(owner)).toBe(1)
    expect(await details(admin)).toBe(1)
    expect(await details(member)).toBeNull()
  })

  it(`deletes who opened a page after 90 days and keeps the counts`, async () => {
    const { owner, member, page } = await orgPage()
    await open(page, 1, { viewer: member })
    await db.execute(sql`update artifact_views set viewed_at = now() - interval '91 days'`)
    // Past the retention it's no longer shown, even before the sweep runs
    expect((await views(page, owner)).body.people).toEqual([])

    expect(await deleteOldViews()).toBe(1)
    expect(await db.select().from(schema.artifactViews)).toEqual([])
    expect((await views(page, owner)).body.total).toBe(1)

    // The scheduled job runs it too
    const another = await createUser()
    await addMember(page.organizationId!, another, 'member')
    await open(page, 1, { viewer: another })
    await db.execute(sql`update artifact_views set viewed_at = now() - interval '91 days'`)
    env.cronSecret = 'a-long-random-secret'
    const res = await call('/api/cron/sweep', { bearer: 'a-long-random-secret' })
    expect(await res.json()).toMatchObject({ views: 1 })
  })

  it('removes the records with the person or the page', async () => {
    const { owner, member, page } = await orgPage()
    await open(page, 1, { viewer: member })
    await db.delete(schema.users).where(sql`${schema.users.id} = ${member.id}`)
    expect(await db.select().from(schema.artifactViews)).toEqual([])
    expect((await views(page, owner)).body.total).toBe(1)
    await db.delete(schema.artifacts).where(sql`${schema.artifacts.id} = ${page.id}`)
    expect(await db.select().from(schema.artifactViewCounts)).toEqual([])
  })

  it('tells agents who can edit the page', async () => {
    const { owner, member, page } = await orgPage()
    await open(page, 1, { viewer: member })
    const { access_token } = await connectAgent(owner, page.organizationId)
    const result = await callTool(access_token, 'list_views', { artifact_id: page.slug })
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('1 view in all')
    expect(result.text).toContain('- Version 1 (current): 1 view')
    expect(result.text).toMatch(new RegExp(`- Mia Member <${member.email}>: last opened .+ UTC \\(version 1\\), 1 view`))

    const { access_token: memberToken } = await connectAgent(member, page.organizationId)
    expect(await callTool(memberToken, 'list_views', { artifact_id: page.slug })).toMatchObject({
      isError: true,
      text: `No page you can edit has the id "${page.slug}".`,
    })
  })
})
