import { generateKeyPairSync } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditSettled } from '../../src/audit.js'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { pruneAuditEvents } from '../../src/ee/audit.js'
import { readSigningKey, signLicense } from '../../src/ee/licenses.js'
import { env } from '../../src/env.js'
import { LICENSE_PUBLIC_KEYS } from '../../src/license.js'
import { buildExport } from '../../src/exports.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000
const original = { selfHosted: env.selfHosted, trustProxy: env.trustProxy, retention: env.auditLogRetentionDays, cronSecret: env.cronSecret }

const signer = (() => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))
  if (!key) throw new Error('no key')
  return key
})()

async function license(expiresAt = new Date(Date.now() + 365 * DAY)) {
  const licenseKey = signLicense(
    {
      id: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11',
      customer: 'Acme Inc',
      email: 'it@acme.example',
      seats: 50,
      issuedAt: new Date(expiresAt.getTime() - 400 * DAY).toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    signer,
  )
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', licenseKey })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set: { licenseKey } })
}

beforeEach(() => {
  env.selfHosted = true
  LICENSE_PUBLIC_KEYS[signer.keyId] = signer.publicKey
})

afterEach(async () => {
  await auditSettled()
  env.selfHosted = original.selfHosted
  env.trustProxy = original.trustProxy
  env.auditLogRetentionDays = original.retention
  env.cronSecret = original.cronSecret
  delete LICENSE_PUBLIC_KEYS[signer.keyId]
})

type Event = {
  id: string
  action: string
  at: string
  actor: { id: string | null; email: string | null } | null
  target: { type: string; id: string; label: string } | null
  details: Record<string, unknown>
  ip: string | null
  userAgent: string | null
}

async function log(user: TestUser, orgId: string, query = '') {
  await auditSettled()
  const res = await call(`/api/organizations/${orgId}/audit-log${query}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { events: Event[]; next: string | null; actions: string[] }
}

async function stored() {
  await auditSettled()
  return db.select().from(schema.auditEvents)
}

async function withPassword(user: TestUser, password = 'correct horse battery') {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(schema.users.id, user.id))
}

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  call('/api/auth/password/login', { json: { email, password }, headers })

describe('audit log recording', () => {
  it('records nothing without a license', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    await withPassword(owner)
    expect((await login(owner.email, 'correct horse battery')).status).toBe(200)
    await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { name: 'Acme Two' } })
    expect(await stored()).toEqual([])

    const res = await call(`/api/organizations/${org.id}/audit-log`, { cookie: owner.cookie })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'enterprise_required' })
  })

  it('records nothing on the hosted service, whatever key is stored', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    env.selfHosted = false
    await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { name: 'Acme Two' } })
    expect(await stored()).toEqual([])
    expect((await call(`/api/organizations/${org.id}/audit-log`, { cookie: owner.cookie })).status).toBe(403)
  })

  it('records nothing once the grace period is over, and keeps recording during it', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const rename = (name: string) => call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { name } })

    await license(new Date(Date.now() - 3 * DAY))
    await rename('In grace')
    expect(await stored()).toHaveLength(1)

    await license(new Date(Date.now() - 30 * DAY))
    await rename('After grace')
    expect(await stored()).toHaveLength(1)
  })

  it('records sign-ins, failed ones included, in every organization of the person, with address and browser', async () => {
    await license()
    env.trustProxy = 1
    const owner = await createUser()
    const acme = await createOrg(owner, 'Acme', 'acme')
    const other = await createOrg(await createUser(), 'Other', 'other')
    await addMember(other.id, owner, 'member')
    const outsider = await createUser()
    await withPassword(owner)
    await withPassword(outsider)

    const headers = { 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Mozilla/5.0 Test' }
    expect((await login(owner.email, 'wrong password', headers)).status).toBe(401)
    expect((await login(owner.email, 'correct horse battery', headers)).status).toBe(200)
    expect((await login(outsider.email, 'correct horse battery')).status).toBe(200)
    expect((await login('nobody@example.com', 'whatever')).status).toBe(401)

    const { events } = await log(owner, acme.id)
    expect(events.map((e) => e.action)).toEqual(['sign_in.succeeded', 'sign_in.failed'])
    expect(events[0]).toMatchObject({
      actor: { id: owner.id, email: owner.email },
      details: { method: 'password' },
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 Test',
    })
    expect(events[1].details).toEqual({ reason: 'wrong password' })

    // The same sign-ins in the other organization; nothing about people outside either
    const rows = await stored()
    expect(rows.filter((r) => r.organizationId === other.id).map((r) => r.action)).toHaveLength(2)
    expect(rows.every((r) => r.actorId === owner.id)).toBe(true)
  })

  it('records sharing and general access changes of organization pages only', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const page = await createPage(owner, { organizationId: org.id, title: 'Roadmap' })
    const personal = await createPage(owner, { title: 'Mine' })

    await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { visibility: 'link' } })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: ['guest@example.com'], role: 'viewer', notify: false } })
    await call(`/api/artifacts/${page.slug}/sharing/people`, { method: 'PATCH', cookie: owner.cookie, json: { email: 'guest@example.com', role: 'editor' } })
    await call(`/api/artifacts/${page.slug}/sharing/people?email=guest%40example.com`, { method: 'DELETE', cookie: owner.cookie })
    await call(`/api/artifacts/${personal.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { visibility: 'link' } })
    await call(`/api/artifacts/${personal.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: ['guest@example.com'], notify: false } })

    const { events } = await log(owner, org.id)
    expect(events.map((e) => [e.action, e.details])).toEqual([
      ['page.unshared', { person: 'guest@example.com' }],
      ['page.share_role_changed', { person: 'guest@example.com', role: 'editor' }],
      ['page.shared', { people: ['guest@example.com'], role: 'viewer' }],
      ['page.visibility_changed', { from: 'organization', to: 'link' }],
    ])
    expect(events[0].target).toEqual({ type: 'page', id: page.slug, label: 'Roadmap' })
    expect(await stored()).toHaveLength(4)
  })

  it('records link settings: expiry, password and reset, never the password', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const page = await createPage(owner, { organizationId: org.id, visibility: 'link', title: 'Roadmap' })
    const patch = (json: unknown) => call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: owner.cookie, json })

    expect((await patch({ linkExpiresAt: '2099-12-31', linkPassword: 'open sesame 42' })).status).toBe(200)
    expect((await patch({ rotateLink: true })).status).toBe(200)
    expect((await patch({ linkPassword: null, linkExpiresAt: null })).status).toBe(200)
    // Removing what isn't there changes nothing
    expect((await patch({ linkPassword: null })).status).toBe(200)

    const { events } = await log(owner, org.id)
    expect(events.map((e) => [e.action, e.details])).toEqual([
      ['page.link_changed', { expiresAt: { from: '2099-12-31T23:59:59.999Z', to: null }, password: 'removed' }],
      ['page.link_changed', { reset: true }],
      ['page.link_changed', { expiresAt: { from: null, to: '2099-12-31T23:59:59.999Z' }, password: 'set' }],
    ])
    expect(JSON.stringify(events)).not.toContain('sesame')
  })

  it('records member changes, settings and access tokens', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const leaver = await createUser()
    await addMember(org.id, leaver, 'member')

    await call(`/api/organizations/${org.id}`, { method: 'PATCH', cookie: owner.cookie, json: { name: 'Acme Two' } })
    await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'gone@example.com', role: 'member' } })
    const [gone] = await db.select().from(schema.invitations)
    await call(`/api/organizations/${org.id}/invitations/${gone.id}`, { method: 'DELETE', cookie: owner.cookie })
    // Invited before they have an account, so they accept rather than being added at once
    await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'joiner@example.com', role: 'admin' } })
    const joiner = await createUser({ email: 'joiner@example.com' })
    const [invite] = await db.select().from(schema.invitations)
    expect((await call(`/api/me/invitations/${invite.id}/accept`, { method: 'POST', cookie: joiner.cookie })).status).toBe(200)
    await call(`/api/organizations/${org.id}/members/${joiner.id}`, { method: 'PATCH', cookie: owner.cookie, json: { role: 'member' } })
    await call(`/api/organizations/${org.id}/members/${joiner.id}`, { method: 'DELETE', cookie: owner.cookie })
    await call(`/api/organizations/${org.id}/members/${leaver.id}`, { method: 'DELETE', cookie: leaver.cookie })

    const created = await call('/api/me/access-tokens', { cookie: owner.cookie, json: { name: 'CI', organizationId: org.id } })
    const { accessToken } = (await created.json()) as { accessToken: { id: string } }
    await call(`/api/organizations/${org.id}/access-tokens/${accessToken.id}`, { method: 'DELETE', cookie: owner.cookie })
    // A personal token is nobody's organization's business
    await call('/api/me/access-tokens', { cookie: owner.cookie, json: { name: 'Laptop', organizationId: null } })

    const { events } = await log(owner, org.id)
    expect(events.map((e) => e.action)).toEqual([
      'access_token.revoked',
      'access_token.created',
      'member.left',
      'member.removed',
      'member.role_changed',
      'member.joined',
      'member.invited',
      'member.invitation_revoked',
      'member.invited',
      'organization.settings_changed',
    ])
    const by = (action: string) => events.find((e) => e.action === action)!
    expect(by('organization.settings_changed').details).toEqual({ name: { from: 'Acme Inc', to: 'Acme Two' } })
    expect(by('member.joined')).toMatchObject({ actor: { email: joiner.email }, target: { type: 'member', id: joiner.id, label: joiner.email } })
    expect(by('member.role_changed').details).toEqual({ from: 'admin', to: 'member' })
    expect(by('member.left').actor?.id).toBe(leaver.id)
    expect(by('access_token.created').target).toEqual({ type: 'access_token', id: accessToken.id, label: 'CI' })
  })
})

describe('audit log recording of pages, retention, exports and agents', () => {
  it('records deleted pages, retention changes, organization exports and agents connecting and disconnecting', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const [gone, byAgent] = [
      await createPage(owner, { organizationId: org.id, title: 'Roadmap' }),
      await createPage(owner, { organizationId: org.id, title: 'Draft' }),
    ]
    const personal = await createPage(owner, { title: 'Mine' })

    expect((await call(`/api/artifacts/${gone.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect((await call(`/api/artifacts/${personal.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    const retention = (json: Record<string, unknown>) => call(`/api/organizations/${org.id}/retention`, { method: 'PUT', cookie: owner.cookie, json })
    expect((await retention({ keepDays: 30, keepVersions: null })).status).toBe(200)
    // Saving the same policy again changes nothing, so nothing is recorded
    expect((await retention({ keepDays: 30, keepVersions: null })).status).toBe(200)

    const requested = await call('/api/exports', { cookie: owner.cookie, json: { organizationId: org.id, versions: 'current' } })
    expect(requested.status).toBe(202)
    const { export: created } = (await requested.json()) as { export: { id: string } }
    expect(await buildExport(created.id)).toBe('done')
    const { export: ready } = (await (await call(`/api/exports?organizationId=${org.id}`, { cookie: owner.cookie })).json()) as {
      export: { downloadUrl: string }
    }
    expect([200, 302]).toContain((await call(ready.downloadUrl, { cookie: owner.cookie })).status)
    // An account's own export is nobody's organization's business
    expect((await call('/api/exports', { cookie: owner.cookie, json: { versions: 'current' } })).status).toBe(202)

    const tokens = await connectAgent(owner, org.id, 'Claude Code')
    expect((await callTool(tokens.access_token, 'delete_artifact', { artifact_id: byAgent.slug })).isError).toBeFalsy()
    const [agent] = (await (await call('/api/me/agents', { cookie: owner.cookie })).json()) as { clientId: string }[]
    expect((await call(`/api/me/agents/${agent.clientId}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)

    const { events } = await log(owner, org.id)
    expect(events.map((e) => e.action).sort()).toEqual(
      [
        'page.deleted',
        'organization.retention_changed',
        'organization.export_requested',
        'organization.export_downloaded',
        'agent.connected',
        'page.deleted',
        'agent.disconnected',
      ].sort(),
    )
    const by = (action: string) => events.filter((e) => e.action === action)
    expect(by('page.deleted').map((e) => e.target)).toEqual(
      expect.arrayContaining([
        { type: 'page', id: gone.slug, label: 'Roadmap' },
        { type: 'page', id: byAgent.slug, label: 'Draft' },
      ]),
    )
    expect(by('page.deleted').every((e) => e.actor?.id === owner.id)).toBe(true)
    expect(by('organization.retention_changed')[0].details).toEqual({ keepDays: { from: null, to: 30 } })
    expect(by('organization.export_requested')[0].details).toEqual({ exportId: created.id, versions: 'current' })
    expect(by('organization.export_downloaded')[0].details).toEqual({ exportId: created.id, versions: 'current' })
    expect(by('agent.connected')[0]).toMatchObject({ actor: { id: owner.id }, target: { type: 'agent', id: agent.clientId, label: 'Claude Code' } })
    expect(by('agent.disconnected')[0]).toMatchObject({ target: { type: 'agent', id: agent.clientId }, details: { via: 'settings' } })
  })

  it('records an agent that signs itself out', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const tokens = await connectAgent(owner, org.id)
    const res = await call('/oauth/revoke', { form: { token: tokens.refresh_token } })
    expect(res.status).toBe(200)
    const { events } = await log(owner, org.id)
    expect(events.find((e) => e.action === 'agent.disconnected')).toMatchObject({ actor: { id: owner.id }, details: { via: 'agent' } })
  })
})

describe('audit log access', () => {
  it('is for owners and admins; everyone else gets a 404', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const admin = await createUser()
    const member = await createUser()
    await addMember(org.id, admin, 'admin')
    await addMember(org.id, member, 'member')
    const outsider = await createUser()

    expect((await call(`/api/organizations/${org.id}/audit-log`, { cookie: admin.cookie })).status).toBe(200)
    for (const who of [member, outsider]) {
      expect((await call(`/api/organizations/${org.id}/audit-log`, { cookie: who.cookie })).status).toBe(404)
      expect((await call(`/api/organizations/${org.id}/audit-log/export`, { cookie: who.cookie })).status).toBe(404)
    }
    expect((await call('/api/organizations/not-an-id/audit-log', { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/organizations/${org.id}/audit-log`)).status).toBe(401)
  })
})

async function seed(orgId: string, rows: Partial<typeof schema.auditEvents.$inferInsert>[]) {
  await db.insert(schema.auditEvents).values(rows.map((r) => ({ organizationId: orgId, action: 'sign_in.succeeded', ...r })))
}

describe('audit log filters and paging', () => {
  it('filters by action, actor and dates and pages with a cursor', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    await seed(org.id, [
      { action: 'sign_in.succeeded', actorEmail: 'ana@example.com', createdAt: new Date('2026-03-01T10:00:00Z') },
      { action: 'sign_in.failed', actorEmail: 'ana@example.com', createdAt: new Date('2026-03-02T10:00:00Z') },
      { action: 'member.invited', actorEmail: 'bo@example.com', createdAt: new Date('2026-03-03T10:00:00Z') },
      { action: 'sign_in.succeeded', actorEmail: 'bo@example.com', createdAt: new Date('2026-03-04T10:00:00Z') },
    ])
    const other = await createOrg(await createUser(), 'Other', 'other')
    await seed(other.id, [{ actorEmail: 'ana@example.com', createdAt: new Date('2026-03-01T11:00:00Z') }])

    const dates = (r: { events: Event[] }) => r.events.map((e) => e.at.slice(0, 10))
    expect(dates(await log(owner, org.id))).toEqual(['2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01'])
    expect(dates(await log(owner, org.id, '?action=sign_in.succeeded'))).toEqual(['2026-03-04', '2026-03-01'])
    expect(dates(await log(owner, org.id, '?actor=ANA@'))).toEqual(['2026-03-02', '2026-03-01'])
    expect(dates(await log(owner, org.id, '?from=2026-03-02&to=2026-03-04'))).toEqual(['2026-03-03', '2026-03-02'])

    const first = await log(owner, org.id, '?limit=3')
    expect(dates(first)).toEqual(['2026-03-04', '2026-03-03', '2026-03-02'])
    const second = await log(owner, org.id, `?limit=3&cursor=${first.next}`)
    expect(dates(second)).toEqual(['2026-03-01'])
    expect(second.next).toBeNull()

    const bad = await call(`/api/organizations/${org.id}/audit-log?action=page.destroyed`, { cookie: owner.cookie })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ field: 'action' })
    expect((await call(`/api/organizations/${org.id}/audit-log?from=yesterday`, { cookie: owner.cookie })).status).toBe(400)
    expect((await call(`/api/organizations/${org.id}/audit-log?cursor=nonsense`, { cookie: owner.cookie })).status).toBe(400)
  })
})

describe('audit log export', () => {
  it('exports the matching events as CSV and JSON', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    await seed(org.id, [
      {
        action: 'page.shared',
        actorEmail: 'ana@example.com',
        targetType: 'page',
        targetId: 'abc',
        targetLabel: '=HYPERLINK("x"), "quoted"',
        details: { people: ['b@example.com'] },
        ip: '203.0.113.9',
        createdAt: new Date('2026-03-02T10:00:00Z'),
      },
      { action: 'sign_in.succeeded', actorEmail: 'bo@example.com', createdAt: new Date('2026-03-01T10:00:00Z') },
    ])

    const csv = await call(`/api/organizations/${org.id}/audit-log/export?format=csv`, { cookie: owner.cookie })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-log-acme-\d{4}-\d{2}-\d{2}\.csv"$/)
    const lines = (await csv.text()).trim().split('\r\n')
    expect(lines[0]).toBe('time,action,actor_email,actor_id,target_type,target_id,target_label,details,ip,user_agent')
    expect(lines).toHaveLength(3)
    // A cell that starts like a formula is quoted so spreadsheets show it as text
    expect(lines[1]).toBe(
      `2026-03-02T10:00:00.000Z,page.shared,ana@example.com,,page,abc,"'=HYPERLINK(""x""), ""quoted""","{""people"":[""b@example.com""]}",203.0.113.9,`,
    )

    const json = await call(`/api/organizations/${org.id}/audit-log/export?format=json&action=sign_in.succeeded`, { cookie: owner.cookie })
    expect(json.headers.get('content-type')).toContain('application/json')
    const events = (await json.json()) as Event[]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'sign_in.succeeded', actor: { email: 'bo@example.com' } })

    const empty = await call(`/api/organizations/${org.id}/audit-log/export?format=json&actor=nobody`, { cookie: owner.cookie })
    expect(await empty.json()).toEqual([])
    expect((await call(`/api/organizations/${org.id}/audit-log/export?format=xml`, { cookie: owner.cookie })).status).toBe(400)
  })

  it('exports more events than fit in one batch', async () => {
    await license()
    const owner = await createUser()
    const org = await createOrg(owner)
    const start = Date.now() - DAY
    await seed(
      org.id,
      Array.from({ length: 2500 }, (_, i) => ({ actorEmail: `p${i}@example.com`, createdAt: new Date(start + i * 1000) })),
    )
    const res = await call(`/api/organizations/${org.id}/audit-log/export?format=json`, { cookie: owner.cookie })
    const events = (await res.json()) as Event[]
    expect(events).toHaveLength(2500)
    expect(new Set(events.map((e) => e.id)).size).toBe(2500)
  })
})

describe('audit log retention', () => {
  it('deletes events older than the retention period, 365 days unless set', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const now = Date.now()
    await seed(org.id, [
      { actorEmail: 'old@example.com', createdAt: new Date(now - 400 * DAY) },
      { actorEmail: 'month@example.com', createdAt: new Date(now - 40 * DAY) },
      { actorEmail: 'new@example.com', createdAt: new Date(now - DAY) },
    ])

    expect(env.auditLogRetentionDays).toBe(365)
    expect(await pruneAuditEvents()).toBe(1)

    env.auditLogRetentionDays = 30
    env.cronSecret = 'a-long-random-secret'
    expect((await call('/api/cron/sweep', { bearer: 'a-long-random-secret' })).status).toBe(200)
    expect((await stored()).map((r) => r.actorEmail)).toEqual(['new@example.com'])
  })
})
