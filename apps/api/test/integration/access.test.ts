import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { downloadLink } from '../../src/content.js'
import { db, schema } from '../../src/db/index.js'
import type { Visibility } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

type Who = 'anonymous' | 'owner' | 'viewer' | 'editor' | 'member' | 'admin' | 'orgOwner' | 'stranger'
type Expected = 'edit' | 'view' | 'none'

// Rows: who is asking. Columns: the page's general access. Like Google Drive.
const MATRIX: Record<Who, Record<Visibility, Expected>> = {
  anonymous: { private: 'none', organization: 'none', link: 'view' },
  owner: { private: 'edit', organization: 'edit', link: 'edit' },
  viewer: { private: 'view', organization: 'view', link: 'view' },
  editor: { private: 'edit', organization: 'edit', link: 'edit' },
  member: { private: 'none', organization: 'view', link: 'view' },
  admin: { private: 'edit', organization: 'edit', link: 'edit' },
  orgOwner: { private: 'edit', organization: 'edit', link: 'edit' },
  stranger: { private: 'none', organization: 'none', link: 'view' },
}

let people: Record<Exclude<Who, 'anonymous'>, TestUser>
let orgId: string

beforeEach(async () => {
  const orgOwner = await createUser({ email: 'founder@example.com' })
  const org = await createOrg(orgOwner, 'Acme', 'acme')
  orgId = org.id
  people = {
    orgOwner,
    // The author is a plain member who published into the organization
    owner: await createUser({ email: 'author@example.com' }),
    viewer: await createUser({ email: 'viewer@example.com' }),
    editor: await createUser({ email: 'editor@example.com' }),
    member: await createUser({ email: 'member@example.com' }),
    admin: await createUser({ email: 'admin@example.com' }),
    stranger: await createUser({ email: 'stranger@example.com' }),
  }
  await addMember(orgId, people.owner, 'member')
  await addMember(orgId, people.member, 'member')
  await addMember(orgId, people.admin, 'admin')
})

async function orgPage(visibility: Visibility) {
  const page = await createPage(people.owner, { organizationId: orgId, visibility, html: '<p>secret sauce</p>' })
  await db.insert(schema.artifactShares).values([
    { artifactId: page.id, email: 'viewer@example.com', role: 'viewer', invitedBy: people.owner.id },
    { artifactId: page.id, email: 'editor@example.com', role: 'editor', invitedBy: people.owner.id },
  ])
  return page
}

// The page's details and its served content must agree on who gets in
async function access(slug: string, who: Who): Promise<Expected> {
  const cookie = who === 'anonymous' ? undefined : people[who].cookie
  const res = await call(`/api/artifacts/${slug}`, { cookie })
  const content = await call(`/api/artifacts/${slug}/v/1/`, { cookie })
  const download = await call(`/api/artifacts/${slug}/download`, { cookie })
  if (res.status === 404) {
    expect(content.status).toBe(404)
    expect(download.status).toBe(404)
    return 'none'
  }
  expect(download.status).toBe(200)
  expect(download.headers.get('content-type')).toBe('application/zip')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.contentUrl).toBe(`/api/artifacts/${slug}/v/1/`)
  expect(content.status).toBe(200)
  expect(await content.text()).toBe('<p>secret sauce</p>')
  expect(content.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads')
  expect(content.headers.get('x-content-type-options')).toBe('nosniff')
  expect(content.headers.get('cache-control')).toBe('private, no-cache')
  return body.canEdit ? 'edit' : 'view'
}

async function canManage(slug: string, who: Who) {
  if (who === 'anonymous') return (await call(`/api/artifacts/${slug}/sharing`)).status === 200
  return (await call(`/api/artifacts/${slug}/sharing`, { cookie: people[who].cookie })).status === 200
}

describe('access matrix for an organization page', () => {
  for (const visibility of ['private', 'organization', 'link'] as const) {
    it(`${visibility}`, async () => {
      const page = await orgPage(visibility)
      const actual = {} as Record<Who, Expected>
      const managing = {} as Record<Who, boolean>
      for (const who of Object.keys(MATRIX) as Who[]) {
        actual[who] = await access(page.slug, who)
        managing[who] = await canManage(page.slug, who)
      }
      const expected = Object.fromEntries(Object.entries(MATRIX).map(([who, row]) => [who, row[visibility]]))
      expect(actual).toEqual(expected)
      // Only people who can edit see and change sharing settings
      expect(managing).toEqual(Object.fromEntries(Object.entries(expected).map(([who, level]) => [who, level === 'edit'])))
    })
  }
})

describe('access to a personal page', () => {
  it('private: only the owner and people it is shared with', async () => {
    const page = await createPage(people.owner, { html: '<p>secret sauce</p>' })
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: 'viewer@example.com', role: 'viewer' })
    expect(await access(page.slug, 'owner')).toBe('edit')
    expect(await access(page.slug, 'viewer')).toBe('view')
    // Organization roles don't reach personal pages
    expect(await access(page.slug, 'orgOwner')).toBe('none')
    expect(await access(page.slug, 'admin')).toBe('none')
    expect(await access(page.slug, 'stranger')).toBe('none')
    expect(await access(page.slug, 'anonymous')).toBe('none')
  })

  it('link: anyone can view, nobody else can edit', async () => {
    const page = await createPage(people.owner, { visibility: 'link', html: '<p>secret sauce</p>' })
    expect(await access(page.slug, 'anonymous')).toBe('view')
    expect(await access(page.slug, 'stranger')).toBe('view')
    expect(await access(page.slug, 'owner')).toBe('edit')
  })

  it('a missing page looks like a private one', async () => {
    const res = await call('/api/artifacts/doesnotexist', { cookie: people.owner.cookie })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('changing and deleting pages', () => {
  it('only people who can edit change general access', async () => {
    const page = await orgPage('private')
    const patch = (who: Exclude<Who, 'anonymous'>, visibility: string) =>
      call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: people[who].cookie, json: { visibility } })

    expect((await patch('viewer', 'link')).status).toBe(404)
    expect((await patch('member', 'link')).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', json: { visibility: 'link' } })).status).toBe(401)

    const res = await patch('editor', 'organization')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ visibility: 'organization' })
    expect(await access(page.slug, 'member')).toBe('view')

    expect((await patch('admin', 'public')).status).toBe(400)
  })

  it('personal pages cannot be shared with an organization', async () => {
    const page = await createPage(people.owner)
    const res = await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: people.owner.cookie, json: { visibility: 'organization' } })
    expect(res.status).toBe(400)
  })

  it('only the owner deletes a page', async () => {
    const page = await orgPage('organization')
    for (const who of ['editor', 'admin', 'orgOwner', 'stranger'] as const) {
      expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: people[who].cookie })).status).toBe(404)
    }
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: people.owner.cookie })).status).toBe(204)
    expect(await db.select().from(schema.artifacts)).toHaveLength(0)
    // Versions and shares go with it
    expect(await db.select().from(schema.artifactVersions)).toHaveLength(0)
    expect(await db.select().from(schema.artifactShares)).toHaveLength(0)
  })
})

describe('owners outside the organization', () => {
  const remove = (who: Exclude<Who, 'anonymous'>) =>
    call(`/api/organizations/${orgId}/members/${people[who].id}`, { method: 'DELETE', cookie: people.orgOwner.cookie })

  it('lose what owning its pages gave them once removed, and keep their personal pages', async () => {
    const page = await orgPage('private')
    const personal = await createPage(people.owner, { title: 'Mine', html: '<p>secret sauce</p>' })
    const agent = (await connectAgent(people.owner)).access_token
    expect((await remove('owner')).status).toBe(200)

    expect(await access(page.slug, 'owner')).toBe('none')
    expect(await canManage(page.slug, 'owner')).toBe(false)
    const cookie = people.owner.cookie
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie, json: { visibility: 'link' } })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie, json: { emails: 'friend@example.com', role: 'editor' } })).status).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie })).status).toBe(404)
    for (const [tool, args] of [
      ['get_artifact', {}],
      ['download_artifact', {}],
      ['list_views', {}],
      ['set_artifact_visibility', { visibility: 'link' }],
      ['share_artifact', { emails: ['friend@example.com'] }],
      ['publish_artifact', { title: 'Taken', html: '<p>mine now</p>' }],
      ['delete_artifact', {}],
    ] as const) {
      expect(await callTool(agent, tool, { artifact_id: page.slug, ...args })).toMatchObject({ isError: true })
    }
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect(row).toMatchObject({ visibility: 'private', currentVersion: 1 })
    expect(await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.email, 'friend@example.com'))).toHaveLength(0)

    // The page stays with the organization, and the personal page with its owner
    expect(await access(page.slug, 'admin')).toBe('edit')
    expect(await access(personal.slug, 'owner')).toBe('edit')
    expect(await (await call(`/api/artifacts/${personal.slug}`, { cookie })).json()).toMatchObject({ isOwner: true })
    expect((await callTool(agent, 'rename_artifact', { artifact_id: personal.slug, title: 'Still mine' })).isError).toBe(false)
    expect((await call(`/api/artifacts/${personal.slug}`, { method: 'DELETE', cookie })).status).toBe(204)
  })

  it('keep only what a share gives them', async () => {
    const page = await orgPage('private')
    expect((await remove('owner')).status).toBe(200)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: people.owner.email, role: 'viewer', invitedBy: people.admin.id })
    expect(await access(page.slug, 'owner')).toBe('view')
    expect(await (await call(`/api/artifacts/${page.slug}`, { cookie: people.owner.cookie })).json()).toMatchObject({ isOwner: false, canMove: false })
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: people.owner.cookie })).status).toBe(404)
  })

  it('count as outside it while it requires a second factor they lack', async () => {
    const page = await orgPage('private')
    const personal = await createPage(people.owner, { html: '<p>secret sauce</p>' })
    const agent = (await connectAgent(people.owner)).access_token
    await db.update(schema.organizations).set({ requireTwoFactor: true }).where(eq(schema.organizations.id, orgId))

    expect(await access(page.slug, 'owner')).toBe('none')
    expect((await call(`/api/artifacts/${page.slug}`, { method: 'DELETE', cookie: people.owner.cookie })).status).toBe(404)
    expect(await callTool(agent, 'get_artifact', { artifact_id: page.slug })).toMatchObject({ isError: true })
    expect(await callTool(agent, 'delete_artifact', { artifact_id: page.slug })).toMatchObject({ isError: true })
    expect(await access(personal.slug, 'owner')).toBe('edit')
    expect((await callTool(agent, 'get_artifact', { artifact_id: personal.slug })).isError).toBe(false)
  })
})

describe('tokens for one workspace', () => {
  async function accessToken(who: Exclude<Who, 'anonymous'>, organizationId: string | null) {
    const res = await call('/api/me/access-tokens', { cookie: people[who].cookie, json: { name: 'CI', organizationId } })
    expect(res.status).toBe(201)
    return ((await res.json()) as { token: string }).token
  }

  it("don't carry organization roles or ownership into another workspace", async () => {
    const page = await orgPage('organization')
    const own = await createPage(people.admin, { organizationId: orgId })
    const personal = (await connectAgent(people.admin)).access_token
    for (const [tool, args] of [
      ['get_artifact', {}],
      ['rename_artifact', { title: 'Renamed' }],
      ['set_artifact_visibility', { visibility: 'link' }],
      ['share_artifact', { emails: ['friend@example.com'], role: 'editor' }],
      ['update_files', { files: [{ path: 'extra.css', content: 'p{}' }] }],
      ['move_artifact', { folder: 'Mine' }],
    ] as const) {
      expect(await callTool(personal, tool, { artifact_id: page.slug, ...args })).toMatchObject({ isError: true })
    }
    expect((await callTool(personal, 'delete_artifact', { artifact_id: own.slug })).isError).toBe(true)
    expect((await callTool(personal, 'download_artifact', { artifact_id: own.slug })).isError).toBe(true)

    // POST /api/publish with a personal access token, the same way
    const ci = await accessToken('admin', null)
    const res = await call('/api/publish', { bearer: ci, json: { title: 'Taken', html: '<p>x</p>', artifact_id: page.slug } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: `No page you can edit has the id "${page.slug}". Publish without artifact_id to create a new page.` })
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect(row).toMatchObject({ title: 'Test page', visibility: 'organization', currentVersion: 1 })

    // A token for the organization has them
    const orgAgent = (await connectAgent(people.admin, orgId)).access_token
    expect((await callTool(orgAgent, 'rename_artifact', { artifact_id: page.slug, title: 'Renamed' })).isError).toBe(false)
    const orgCi = await accessToken('admin', orgId)
    expect((await call('/api/publish', { bearer: orgCi, json: { title: 'v2', html: '<p>v2</p>', artifact_id: page.slug } })).status).toBe(200)
    expect((await callTool(orgAgent, 'delete_artifact', { artifact_id: own.slug })).isError).toBe(false)
  })

  it('still open pages shared with the person directly or by link', async () => {
    const shared = await orgPage('private')
    const linked = await createPage(people.owner, { organizationId: orgId, visibility: 'link' })
    const personal = (await connectAgent(people.editor)).access_token
    expect((await callTool(personal, 'get_artifact', { artifact_id: shared.slug })).isError).toBe(false)
    expect((await callTool(personal, 'rename_artifact', { artifact_id: shared.slug, title: 'Edited' })).isError).toBe(false)
    expect((await callTool(personal, 'get_artifact', { artifact_id: linked.slug })).isError).toBe(false)
    // Filing stays with the page's own workspace
    expect((await callTool(personal, 'move_artifact', { artifact_id: shared.slug, folder: 'Mine' })).isError).toBe(true)
  })

  it('pass their limit on to the download links they are given', async () => {
    const page = await orgPage('organization')
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    const path = (link: string) => link.replace(env.appUrl, '')
    expect((await call(path(await downloadLink(people.admin.id, row, 1, { organizationId: orgId })))).status).toBe(200)
    const personalLink = path(await downloadLink(people.admin.id, row, 1, { organizationId: null }))
    expect((await call(personalLink)).status).toBe(404)
    // The workspace is signed with the rest: leaving it out or naming another doesn't open the page
    const token = new URL(personalLink, env.appUrl).searchParams.get('token')!
    const [user, exp, , mac] = token.split('.')
    for (const forged of [`${user}.${exp}.${mac}`, `${user}.${exp}.${orgId.replaceAll('-', '')}.${mac}`]) {
      expect((await call(`/api/artifacts/${page.slug}/download?version=1&token=${forged}`)).status).toBe(404)
    }
    // Links made for the app carry no workspace and open what the person can
    expect((await call(path(await downloadLink(people.admin.id, row, 1)))).status).toBe(200)

    const agent = (await connectAgent(people.admin, orgId)).access_token
    const answer = await callTool(agent, 'download_artifact', { artifact_id: page.slug })
    const link = answer.text.match(/Download: (\S+)/)![1]
    expect((await call(path(link))).status).toBe(200)
  })
})
