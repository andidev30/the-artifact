import { generateKeyPairSync } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { PERSONAL_HISTORY_DAYS, pruneHistory } from '../../src/ee/plans.js'
import { readSigningKey, signLicense } from '../../src/ee/licenses.js'
import { pruneRetention } from '../../src/ee/retention.js'
import { env } from '../../src/env.js'
import { LICENSE_PUBLIC_KEYS } from '../../src/license.js'
import { addMember, call, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000

const { privateKey } = generateKeyPairSync('ed25519')
const signer = readSigningKey(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'))!

async function license(expiresInDays = 365) {
  LICENSE_PUBLIC_KEYS[signer.keyId] = signer.publicKey
  const licenseKey = signLicense(
    {
      id: crypto.randomUUID(),
      customer: 'Acme Inc',
      email: 'it@acme.example',
      seats: 10,
      issuedAt: new Date(Date.now() - 400 * DAY).toISOString(),
      expiresAt: new Date(Date.now() + expiresInDays * DAY).toISOString(),
    },
    signer,
  )
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', licenseKey })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set: { licenseKey } })
}

function republish(owner: TestUser, slug: string, organizationId: string | null) {
  return publish({ userId: owner.id, email: owner.email, organizationId, clientName: 'test', title: 'Page', html: `<p>${crypto.randomUUID()}</p>`, slug })
}

async function withVersions(owner: TestUser, organizationId: string | null, count: number) {
  const page = await createPage(owner, { organizationId })
  for (let i = 1; i < count; i++) await republish(owner, page.slug, organizationId)
  return page
}

async function versions(artifactId: string) {
  const rows = await db
    .select({ version: schema.artifactVersions.version })
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifactId))
  return rows.map((r) => r.version).sort((a, b) => a - b)
}

async function age(artifactId: string, version: number, days: number) {
  await db
    .update(schema.artifactVersions)
    .set({ createdAt: new Date(Date.now() - days * DAY) })
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.version, version)))
}

function setPolicy(user: TestUser, orgId: string, json: unknown) {
  return call(`/api/organizations/${orgId}/retention`, { method: 'PUT', cookie: user.cookie, json })
}

describe('version retention', () => {
  let owner: TestUser
  let orgId: string

  beforeEach(async () => {
    env.selfHosted = true
    owner = await createUser()
    orgId = (await createOrg(owner)).id
  })

  afterEach(() => {
    env.selfHosted = false
    env.cronSecret = ''
    delete LICENSE_PUBLIC_KEYS[signer.keyId]
  })

  it('removes versions older than the policy keeps, never the current one', async () => {
    await license()
    const page = await withVersions(owner, orgId, 3)
    for (const v of [1, 2, 3]) await age(page.id, v, 40)
    expect((await setPolicy(owner, orgId, { keepDays: 30, keepVersions: null })).status).toBe(200)

    expect(await pruneRetention()).toBe(2)
    expect(await versions(page.id)).toEqual([3])
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, page.id))
    expect(row.currentVersion).toBe(3)
  })

  it('keeps versions younger than the policy', async () => {
    await license()
    const page = await withVersions(owner, orgId, 3)
    await age(page.id, 1, 40)
    await age(page.id, 2, 20)
    await setPolicy(owner, orgId, { keepDays: 30 })
    expect(await pruneRetention()).toBe(1)
    expect(await versions(page.id)).toEqual([2, 3])
  })

  it('keeps at most the newest N versions of each page, the current one included', async () => {
    await license()
    const a = await withVersions(owner, orgId, 5)
    const b = await withVersions(owner, orgId, 2)
    await setPolicy(owner, orgId, { keepVersions: 2 })
    expect(await pruneRetention()).toBe(3)
    expect(await versions(a.id)).toEqual([4, 5])
    expect(await versions(b.id)).toEqual([1, 2])
  })

  it('applies either limit, and only to its own organization', async () => {
    await license()
    const other = await createOrg(owner, 'Other', 'other')
    const page = await withVersions(owner, orgId, 4)
    const elsewhere = await withVersions(owner, other.id, 4)
    const personal = await withVersions(owner, null, 4)
    for (const p of [page, elsewhere, personal]) await age(p.id, 3, 400)
    await setPolicy(owner, orgId, { keepDays: 365, keepVersions: 3 })

    expect(await pruneRetention()).toBe(2)
    expect(await versions(page.id)).toEqual([2, 4])
    expect(await versions(elsewhere.id)).toEqual([1, 2, 3, 4])
    expect(await versions(personal.id)).toEqual([1, 2, 3, 4])
  })

  it('previews how many versions a policy would remove without removing them', async () => {
    await license()
    const a = await withVersions(owner, orgId, 4)
    await withVersions(owner, orgId, 3)
    await age(a.id, 1, 100)
    const res = await call(`/api/organizations/${orgId}/retention/preview?keepDays=90&keepVersions=2`, { cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ versions: 3, pages: 2 })
    expect(await versions(a.id)).toEqual([1, 2, 3, 4])
    expect((await call(`/api/organizations/${orgId}/retention/preview?keepDays=0`, { cookie: owner.cookie })).status).toBe(400)
  })

  it('runs before the storage sweep from the scheduled job', async () => {
    await license()
    env.cronSecret = 'secret-for-tests'
    const page = await withVersions(owner, orgId, 3)
    await setPolicy(owner, orgId, { keepVersions: 1 })
    expect((await call('/api/cron/sweep', { bearer: 'secret-for-tests' })).status).toBe(200)
    expect(await versions(page.id)).toEqual([3])
  })

  it('keeps the policy but applies nothing without a license, and needs one to set a policy', async () => {
    const page = await withVersions(owner, orgId, 3)
    const denied = await setPolicy(owner, orgId, { keepVersions: 1 })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'enterprise_required' })
    expect((await call(`/api/organizations/${orgId}/retention/preview?keepVersions=1`, { cookie: owner.cookie })).status).toBe(403)

    // Set while licensed, then the license runs out past its grace period
    await license()
    expect((await setPolicy(owner, orgId, { keepVersions: 1 })).status).toBe(200)
    await license(-30)
    expect(await pruneRetention()).toBe(0)
    expect(await versions(page.id)).toEqual([1, 2, 3])

    const res = await call(`/api/organizations/${orgId}/retention`, { cookie: owner.cookie })
    expect(await res.json()).toMatchObject({ keepDays: null, keepVersions: 1, license: 'expired', applied: false })

    // Turning it off works without a license
    expect((await setPolicy(owner, orgId, { keepDays: null, keepVersions: null })).status).toBe(200)
    expect(await db.select().from(schema.retentionPolicies)).toEqual([])
  })

  it('still applies during the grace period after the license expires', async () => {
    await license()
    const page = await withVersions(owner, orgId, 3)
    await setPolicy(owner, orgId, { keepVersions: 1 })
    await license(-3)
    const res = await call(`/api/organizations/${orgId}/retention`, { cookie: owner.cookie })
    expect(await res.json()).toMatchObject({ license: 'grace', applied: true })
    expect(await pruneRetention()).toBe(2)
    expect(await versions(page.id)).toEqual([3])
  })

  it('lets owners and admins set it, and looks missing to everyone else', async () => {
    await license()
    const admin = await createUser()
    const member = await createUser()
    const outsider = await createUser()
    await addMember(orgId, admin, 'admin')
    await addMember(orgId, member, 'member')

    const saved = await setPolicy(admin, orgId, { keepDays: 90, keepVersions: 20 })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ keepDays: 90, keepVersions: 20, license: 'active', applied: true })

    for (const who of [member, outsider]) {
      expect((await call(`/api/organizations/${orgId}/retention`, { cookie: who.cookie })).status).toBe(404)
      expect((await call(`/api/organizations/${orgId}/retention/preview?keepDays=30`, { cookie: who.cookie })).status).toBe(404)
      expect((await setPolicy(who, orgId, { keepDays: 30 })).status).toBe(404)
    }
    expect((await call(`/api/organizations/${crypto.randomUUID()}/retention`, { cookie: owner.cookie })).status).toBe(404)
    expect((await call(`/api/organizations/${orgId}/retention`)).status).toBe(401)
    const [row] = await db.select().from(schema.retentionPolicies)
    expect(row).toMatchObject({ keepDays: 90, keepVersions: 20, updatedBy: admin.id })
  })

  it('checks the numbers', async () => {
    await license()
    for (const body of [{ keepDays: 0 }, { keepDays: 1.5 }, { keepDays: 'soon' }, { keepDays: 4000 }]) {
      const res = await setPolicy(owner, orgId, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'keepDays' })
    }
    expect(await (await setPolicy(owner, orgId, { keepVersions: -1 })).json()).toMatchObject({ field: 'keepVersions' })
  })

  it('does not exist on the hosted service', async () => {
    env.selfHosted = false
    expect((await call(`/api/organizations/${orgId}/retention`, { cookie: owner.cookie })).status).toBe(404)
    expect(await pruneRetention()).toBe(0)
  })

  it('leaves the hosted Personal plan as it was', async () => {
    env.selfHosted = false
    const personal = await withVersions(owner, null, 3)
    const team = await withVersions(owner, orgId, 3)
    for (const p of [personal, team]) for (const v of [1, 2, 3]) await age(p.id, v, PERSONAL_HISTORY_DAYS + 1)
    // A policy left over in the database changes nothing on the hosted service
    await db.insert(schema.retentionPolicies).values({ organizationId: orgId, keepVersions: 1 })

    expect(await pruneRetention()).toBe(0)
    expect(await pruneHistory()).toBe(2)
    expect(await versions(personal.id)).toEqual([3])
    expect(await versions(team.id)).toEqual([1, 2, 3])
  })
})
