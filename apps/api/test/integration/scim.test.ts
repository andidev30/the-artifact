import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditSettled } from '../../src/audit.js'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { addMember, call, connectAgent, createOrg, createUser, type TestUser } from './helpers.js'
import { disableEnterprise, enableEnterprise, removeTestSigningKeys } from './enterprise.js'

const original = { selfHosted: env.selfHosted }
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User'

let admin: TestUser
let token: string

beforeEach(async () => {
  env.selfHosted = true
  admin = await createUser({ admin: true, email: 'admin@acme.example' })
  await enableEnterprise()
  token = await newToken()
})

afterEach(() => {
  env.selfHosted = original.selfHosted
  removeTestSigningKeys()
})

async function newToken(organizationId?: string) {
  const res = await call('/api/admin/scim/tokens', { cookie: admin.cookie, json: { name: 'Okta', organizationId } })
  expect(res.status).toBe(201)
  return ((await res.json()) as { token: string }).token
}

function scim(path: string, opts: { method?: string; json?: unknown; bearer?: string } = {}) {
  return call(`/scim/v2${path}`, {
    method: opts.method ?? (opts.json === undefined ? 'GET' : 'POST'),
    bearer: opts.bearer ?? token,
    json: opts.json,
  })
}

// Okta's documented POST /Users (developer.okta.com, "SCIM 2.0 protocol reference")
const oktaUser = {
  schemas: [USER],
  userName: 'jane.doe@acme.example',
  name: { givenName: 'Jane', familyName: 'Doe' },
  emails: [{ primary: true, value: 'jane.doe@acme.example', type: 'work' }],
  displayName: 'Jane Doe',
  locale: 'en-US',
  externalId: '00ujl29u0le5T6Aj10h7',
  groups: [],
  password: '1mz050nq',
  active: true,
}

// Entra ID's documented POST /Users (learn.microsoft.com, "Develop a SCIM endpoint")
const entraUser = {
  schemas: [USER, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
  externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
  userName: 'Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1@contoso.example',
  active: true,
  emails: [{ primary: true, type: 'work', value: 'Test_User_fd0ea19b-0777-472c-9f96-4f70d2226f2e@contoso.example' }],
  meta: { resourceType: 'User' },
  name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' },
  roles: [],
}

async function create(body: unknown = oktaUser) {
  const res = await scim('/Users', { json: body })
  expect(res.status).toBe(201)
  expect(res.headers.get('content-type')).toContain('application/scim+json')
  return (await res.json()) as { id: string; userName: string; active: boolean; emails: { value: string }[]; name: Record<string, string> }
}

async function userRow(id: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  return row
}

describe('SCIM Users', () => {
  it('creates a user from Okta’s request', async () => {
    const user = await create()
    expect(user).toMatchObject({
      schemas: [USER],
      userName: 'jane.doe@acme.example',
      externalId: '00ujl29u0le5T6Aj10h7',
      name: { givenName: 'Jane', familyName: 'Doe', formatted: 'Jane Doe' },
      emails: [{ value: 'jane.doe@acme.example', primary: true }],
      active: true,
      meta: { resourceType: 'User', location: `${env.appUrl}/scim/v2/Users/${user.id}` },
    })
    expect(await userRow(user.id)).toMatchObject({ email: 'jane.doe@acme.example', name: 'Jane Doe', isAdmin: false, suspendedAt: null })
  })

  it('creates a user from Entra ID’s request, with the primary email as the address', async () => {
    const user = await create(entraUser)
    expect(user.userName).toBe(entraUser.userName)
    expect((await userRow(user.id)).email).toBe(entraUser.emails[0].value.toLowerCase())
  })

  it('adds new users to the token’s organization', async () => {
    const org = await createOrg(admin)
    const user = await create()
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id))).toHaveLength(0)
    token = await newToken(org.id)
    const second = await create({ ...oktaUser, userName: 'john@acme.example', emails: [{ value: 'john@acme.example', primary: true }], externalId: 'x2' })
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, second.id))
    expect(m).toMatchObject({ organizationId: org.id, role: 'member' })
  })

  it('records joining, deactivating and reactivating in the organization’s audit log', async () => {
    const org = await createOrg(admin)
    token = await newToken(org.id)
    const user = await create()
    const patch = (active: boolean) =>
      scim(`/Users/${user.id}`, { method: 'PATCH', json: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active } }] } })
    await patch(false)
    await patch(true)
    await auditSettled()
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, org.id))
    const mine = events.filter((e) => e.targetId === user.id)
    expect(mine.map((e) => e.action).sort()).toEqual(['member.joined', 'member.reactivated', 'member.suspended'])
    expect(mine.every((e) => e.actorId === null)).toBe(true)
  })

  it('answers 409 uniqueness for an existing userName or email', async () => {
    await create()
    const res = await scim('/Users', { json: oktaUser })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ schemas: [ERROR], status: '409', scimType: 'uniqueness', detail: expect.any(String) })
  })

  it('filters by userName eq, ignoring case, as Okta and Entra ID match accounts', async () => {
    const user = await create()
    await createUser({ email: 'someone@acme.example' })
    const res = await scim(`/Users?filter=${encodeURIComponent('userName eq "Jane.Doe@acme.example"')}&startIndex=1&count=100`)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 1, startIndex: 1, itemsPerPage: 1 })
    expect(list.Resources[0].id).toBe(user.id)

    // Accounts that existed before SCIM match by their email address
    const existing = await (await scim(`/Users?filter=${encodeURIComponent('userName eq "someone@acme.example"')}`)).json()
    expect(existing.totalResults).toBe(1)
    const none = await (await scim(`/Users?filter=${encodeURIComponent('userName eq "nobody@acme.example"')}`)).json()
    expect(none).toMatchObject({ totalResults: 0, Resources: [] })
  })

  it('filters by externalId and lists every user in pages', async () => {
    const user = await create()
    const byExternal = await (await scim(`/Users?filter=${encodeURIComponent('externalId eq "00ujl29u0le5T6Aj10h7"')}`)).json()
    expect(byExternal.Resources.map((r: { id: string }) => r.id)).toEqual([user.id])
    const page = await (await scim('/Users?startIndex=2&count=1')).json()
    expect(page).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 })
  })

  it('clamps paging numbers of any size, and refuses ones that aren’t whole numbers', async () => {
    await create()
    const past = await scim(`/Users?startIndex=${'9'.repeat(30)}&count=${'9'.repeat(30)}`)
    expect(past.status).toBe(200)
    expect(await past.json()).toMatchObject({ totalResults: 2, startIndex: Number.MAX_SAFE_INTEGER, itemsPerPage: 0, Resources: [] })
    // RFC 7644: below 1 means 1, a negative count means none
    expect(await (await scim('/Users?startIndex=-5&count=-1')).json()).toMatchObject({ startIndex: 1, itemsPerPage: 0 })
    for (const query of ['startIndex=1e22', 'count=1.5', 'startIndex=abc', 'count=0x10']) {
      const res = await scim(`/Users?${query}`)
      expect(res.status, query).toBe(400)
      expect(await res.json()).toMatchObject({ schemas: [ERROR], status: '400', scimType: 'invalidValue' })
    }
  })

  it('refuses filters it doesn’t support with invalidFilter', async () => {
    const res = await scim(`/Users?filter=${encodeURIComponent('name.givenName sw "J"')}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ schemas: [ERROR], status: '400', scimType: 'invalidFilter' })
  })

  it('gets one user, and 404 for an unknown id', async () => {
    const user = await create()
    expect((await scim(`/Users/${user.id}`)).status).toBe(200)
    const missing = await scim('/Users/6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ schemas: [ERROR], status: '404' })
  })

  it('replaces a user with PUT, as Okta updates profiles', async () => {
    const user = await create()
    const res = await scim(`/Users/${user.id}`, {
      method: 'PUT',
      json: {
        ...oktaUser,
        id: user.id,
        name: { givenName: 'Janet', familyName: 'Doe' },
        displayName: undefined,
        emails: [{ value: 'janet@acme.example', primary: true }],
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: { givenName: 'Janet', familyName: 'Doe' }, emails: [{ value: 'janet@acme.example' }] })
    expect(await userRow(user.id)).toMatchObject({ email: 'janet@acme.example', name: 'Janet Doe' })
  })

  it('deactivates with Okta’s PATCH: suspended and signed out everywhere', async () => {
    const user = await create()
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    const person = { id: row.id, email: row.email, name: row.name, cookie: '' }
    await db.insert(schema.sessions).values({ id: hashToken('s'), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) })
    await connectAgent({ ...person, cookie: 'session=s' })

    const res = await scim(`/Users/${user.id}`, { method: 'PATCH', json: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: false } }] } })
    expect(res.status).toBe(200)
    expect((await res.json()).active).toBe(false)
    expect((await userRow(user.id)).suspendedAt).toBeInstanceOf(Date)
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toHaveLength(0)
    expect(await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.userId, user.id))).toHaveLength(0)

    const back = await scim(`/Users/${user.id}`, { method: 'PATCH', json: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] } })
    expect((await back.json()).active).toBe(true)
    expect((await userRow(user.id)).suspendedAt).toBeNull()
  })

  it('applies Entra ID’s PATCH, with paths and "False" as a string', async () => {
    const user = await create(entraUser)
    const res = await scim(`/Users/${user.id}`, {
      method: 'PATCH',
      json: {
        schemas: [PATCH],
        Operations: [
          { op: 'Replace', path: 'name.familyName', value: 'updatedFamilyName' },
          { op: 'Add', path: 'emails[type eq "work"].value', value: 'updated@contoso.example' },
          { op: 'Add', path: 'title', value: 'Engineer' },
          { op: 'Replace', path: 'active', value: 'False' },
        ],
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ active: false, name: { givenName: 'givenName', familyName: 'updatedFamilyName' } })
    expect(await userRow(user.id)).toMatchObject({ email: 'updated@contoso.example', name: 'givenName updatedFamilyName' })
  })

  it('deactivates instead of deleting on DELETE', async () => {
    const user = await create()
    const res = await scim(`/Users/${user.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect((await userRow(user.id)).suspendedAt).toBeInstanceOf(Date)
    expect((await (await scim(`/Users/${user.id}`)).json()).active).toBe(false)
  })

  it('won’t deactivate the only admin', async () => {
    const res = await scim(`/Users/${admin.id}`, { method: 'PATCH', json: { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] } })
    expect(res.status).toBe(409)
    expect((await userRow(admin.id)).suspendedAt).toBeNull()
  })

  it('refuses a PATCH that is not a PatchOp', async () => {
    const user = await create()
    const res = await scim(`/Users/${user.id}`, { method: 'PATCH', json: { active: false } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ scimType: 'invalidSyntax' })
  })

  it('describes itself', async () => {
    const res = await scim('/ServiceProviderConfig')
    expect(await res.json()).toMatchObject({ patch: { supported: true }, filter: { supported: true } })
    expect((await scim('/Groups')).status).toBe(404)
  })
})

describe('SCIM tokens for an organization', () => {
  let org: { id: string }
  let other: { id: string }
  beforeEach(async () => {
    org = await createOrg(await createUser({ email: 'owner@acme.example' }), 'Acme', 'acme')
    other = await createOrg(await createUser({ email: 'owner@globex.example' }), 'Globex', 'globex')
    token = await newToken(org.id)
  })

  const patch = (id: string, Operations: unknown[]) => scim(`/Users/${id}`, { method: 'PATCH', json: { schemas: [PATCH], Operations } })
  const emails = async (path = '/Users') => ((await (await scim(path)).json()).Resources as { emails: { value: string }[] }[]).map((r) => r.emails[0].value)

  it('lists and reads only the organization’s members', async () => {
    const created = await create()
    const outsider = await createUser({ email: 'someone@globex.example' })
    expect((await emails()).sort()).toEqual(['jane.doe@acme.example', 'owner@acme.example'])
    expect(await emails(`/Users?filter=${encodeURIComponent('userName eq "someone@globex.example"')}`)).toEqual([])
    expect((await scim(`/Users/${outsider.id}`)).status).toBe(404)
    expect((await scim(`/Users/${admin.id}`)).status).toBe(404)
    expect((await scim(`/Users/${created.id}`)).status).toBe(200)
  })

  it('can’t change or deactivate accounts outside the organization', async () => {
    const outsider = await createUser({ email: 'someone@globex.example' })
    for (const id of [outsider.id, admin.id]) {
      expect((await patch(id, [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'new@evil.example' }])).status).toBe(404)
      expect((await scim(`/Users/${id}`, { method: 'PUT', json: { ...oktaUser, userName: 'new@evil.example' } })).status).toBe(404)
      expect((await scim(`/Users/${id}`, { method: 'DELETE' })).status).toBe(404)
    }
    expect(await userRow(admin.id)).toMatchObject({ email: 'admin@acme.example', suspendedAt: null })
    expect(await userRow(outsider.id)).toMatchObject({ email: 'someone@globex.example', suspendedAt: null })
    // An account that already exists elsewhere isn't created again, nor linked
    expect((await scim('/Users', { json: { ...oktaUser, userName: 'someone@globex.example', emails: [{ value: 'someone@globex.example' }] } })).status).toBe(
      409,
    )
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.userId, outsider.id))).toHaveLength(0)
  })

  it('manages members who are in no other organization', async () => {
    const user = await create()
    const res = await patch(user.id, [
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'janet@acme.example' },
      { op: 'replace', path: 'active', value: false },
    ])
    expect(res.status).toBe(200)
    expect(await userRow(user.id)).toMatchObject({ email: 'janet@acme.example', suspendedAt: expect.any(Date) })
  })

  it('only takes members who are also elsewhere, or instance admins, out of the organization', async () => {
    const shared = await createUser({ email: 'shared@acme.example' })
    await addMember(org.id, shared, 'member')
    await addMember(other.id, shared, 'member')
    await addMember(org.id, admin, 'admin')
    await connectAgent(shared, org.id)
    await connectAgent(shared, other.id, 'cursor')

    for (const person of [shared, admin]) {
      const res = await patch(person.id, [
        { op: 'replace', path: 'emails[type eq "work"].value', value: `x-${person.id}@evil.example` },
        { op: 'replace', path: 'name.familyName', value: 'Changed' },
      ])
      expect(res.status).toBe(200)
      expect(await userRow(person.id)).toMatchObject({ email: person.email, name: null, suspendedAt: null })
    }

    const off = await patch(shared.id, [{ op: 'replace', path: 'active', value: false }])
    expect(off.status).toBe(200)
    expect((await off.json()).active).toBe(false)
    expect((await userRow(shared.id)).suspendedAt).toBeNull()
    const left = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, shared.id))
    expect(left.map((m) => m.organizationId)).toEqual([other.id])
    // Agents connected to the organization go with it, the others stay
    const agents = await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.userId, shared.id))
    expect(new Set(agents.map((t) => t.organizationId))).toEqual(new Set([other.id]))
    expect((await scim(`/Users/${shared.id}`)).status).toBe(404)

    expect((await scim(`/Users/${admin.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await userRow(admin.id)).suspendedAt).toBeNull()
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.userId, admin.id))).toHaveLength(0)

    await auditSettled()
    const events = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, org.id))
    expect(
      events
        .filter((e) => e.action === 'member.removed')
        .map((e) => e.targetId)
        .sort(),
    ).toEqual([shared.id, admin.id].sort())
  })

  it('won’t take out the organization’s only owner', async () => {
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.email, 'owner@acme.example'))
    await db.insert(schema.memberships).values({ organizationId: other.id, userId: owner.id, role: 'member' })
    const res = await scim(`/Users/${owner.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ scimType: 'mutability' })
  })
})

describe('SCIM tokens', () => {
  it('refuses a missing or wrong token with a SCIM 401', async () => {
    const res = await call('/scim/v2/Users')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(await res.json()).toMatchObject({ schemas: [ERROR], status: '401' })
    expect((await scim('/Users', { bearer: 'scim_wrong' })).status).toBe(401)
    expect((await scim('/Users', { bearer: 'not-a-scim-token' })).status).toBe(401)
  })

  it('stores only the hash, and stops working once revoked', async () => {
    const [row] = await db.select().from(schema.scimTokens)
    expect(row.tokenHash).toBe(hashToken(token))
    const list = await (await call('/api/admin/scim', { cookie: admin.cookie })).json()
    expect(JSON.stringify(list)).not.toContain(token)
    await call(`/api/admin/scim/tokens/${row.id}`, { method: 'DELETE', cookie: admin.cookie })
    expect((await scim('/Users')).status).toBe(401)
  })

  it('are for instance admins only', async () => {
    const other = await createUser()
    expect((await call('/api/admin/scim/tokens', { cookie: other.cookie, json: { name: 'x' } })).status).toBe(403)
  })
})

describe('SCIM without a license', () => {
  it('answers 403 in SCIM’s format', async () => {
    await disableEnterprise()
    const res = await scim('/Users')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ schemas: [ERROR], status: '403' })
    expect((await call('/api/admin/scim/tokens', { cookie: admin.cookie, json: { name: 'x' } })).status).toBe(403)
  })

  it('is off on the hosted service', async () => {
    env.selfHosted = false
    const res = await scim('/Users')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ schemas: [ERROR], status: '404' })
    expect((await call('/api/admin/scim', { cookie: admin.cookie })).status).toBe(404)
  })
})
