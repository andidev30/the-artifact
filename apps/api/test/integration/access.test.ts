import { beforeEach, describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import type { Visibility } from '../../src/db/schema.js'
import { addMember, call, createOrg, createPage, createUser, type TestUser } from './helpers.js'

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

async function access(slug: string, who: Who): Promise<Expected> {
  const res = await call(`/api/artifacts/${slug}`, { cookie: who === 'anonymous' ? undefined : people[who].cookie })
  if (res.status === 404) return 'none'
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.html).toBe('<p>secret sauce</p>')
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
