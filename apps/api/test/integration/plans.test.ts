import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { PERSONAL_HISTORY_DAYS, PERSONAL_PAGES, PERSONAL_STORAGE_BYTES, pruneHistory } from '../../src/ee/plans.js'
import { env } from '../../src/env.js'
import { call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const DAY = 24 * 60 * 60 * 1000

// Pages straight in the database, which is much faster than publishing each one
async function fillPersonalWorkspace(owner: TestUser, pages: number) {
  await db
    .insert(schema.artifacts)
    .values(Array.from({ length: pages }, (_, i) => ({ slug: `fill${i}${owner.id.slice(0, 8)}`, title: `Page ${i}`, ownerId: owner.id })))
}

function republish(owner: TestUser, slug: string, organizationId: string | null = null) {
  return publish({ userId: owner.id, email: owner.email, organizationId, clientName: 'test', title: 'Page', html: `<p>${crypto.randomUUID()}</p>`, slug })
}

async function versions(artifactId: string) {
  const rows = await db
    .select({ version: schema.artifactVersions.version })
    .from(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, artifactId))
  return rows.map((r) => r.version).sort()
}

async function age(artifactId: string, version: number, days: number) {
  await db
    .update(schema.artifactVersions)
    .set({ createdAt: new Date(Date.now() - days * DAY) })
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.version, version)))
}

describe('the free Personal plan on the hosted service', () => {
  afterEach(() => {
    env.selfHosted = false
    env.cronSecret = ''
  })

  it(`holds up to ${PERSONAL_PAGES} pages in a personal workspace, and new versions still publish`, async () => {
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    await fillPersonalWorkspace(owner, PERSONAL_PAGES - 1)
    const last = await createPage(owner)

    const res = await callTool(token, 'publish_artifact', { title: 'One too many', html: '<p>x</p>' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^Your personal workspace has 50 pages, the most the free Personal plan allows\./)
    expect(await db.select().from(schema.artifacts).where(eq(schema.artifacts.title, 'One too many'))).toEqual([])

    expect((await republish(owner, last.slug)).currentVersion).toBe(2)
  })

  it('counts only the personal workspace; organizations have no limit yet', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    await fillPersonalWorkspace(owner, PERSONAL_PAGES)
    const page = await createPage(owner, { organizationId: org.id })
    expect(page.organizationId).toBe(org.id)
    await expect(createPage(owner)).rejects.toThrow(/the most the free Personal plan allows/)
  })

  it('holds 1 GB of versions in a personal workspace; organizations have no limit yet', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const token = (await connectAgent(owner)).access_token
    const page = await createPage(owner)
    // As if its versions added up to all but 50 bytes of the plan
    await db
      .update(schema.artifactVersions)
      .set({ htmlSize: PERSONAL_STORAGE_BYTES - 50 })
      .where(eq(schema.artifactVersions.artifactId, page.id))

    const res = await callTool(token, 'publish_artifact', { title: 'Page', html: `<p>${'x'.repeat(100)}</p>`, artifact_id: page.slug })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/^This would take your personal workspace past 1 GB of storage, the most the free Personal plan allows \(1024 MB used/)
    expect(res.text).toMatch(/Versions older than 7 days are removed every day, which frees space as well\.$/)
    expect((await republish(owner, page.slug)).currentVersion).toBe(2)

    await createPage(owner, { organizationId: org.id, html: `<p>${'x'.repeat(100)}</p>` })
    env.selfHosted = true
    expect((await republish(owner, page.slug)).currentVersion).toBe(3)
  })

  it(`deletes versions older than ${PERSONAL_HISTORY_DAYS} days, never the current one or an organization's`, async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const personal = await createPage(owner)
    await republish(owner, personal.slug)
    await republish(owner, personal.slug)
    const team = await createPage(owner, { organizationId: org.id })
    await republish(owner, team.slug, org.id)
    for (const v of [1, 2, 3]) await age(personal.id, v, PERSONAL_HISTORY_DAYS + 1)
    await age(team.id, 1, PERSONAL_HISTORY_DAYS + 1)

    expect(await pruneHistory()).toBe(2)
    expect(await versions(personal.id)).toEqual([3])
    expect(await versions(team.id)).toEqual([1, 2])
    expect((await call(`/api/artifacts/${personal.slug}/v/3/`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`/api/artifacts/${personal.slug}/v/1/`, { cookie: owner.cookie })).status).toBe(404)
  })

  it('keeps versions from the last week', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    await republish(owner, page.slug)
    await age(page.id, 1, PERSONAL_HISTORY_DAYS - 1)
    expect(await pruneHistory()).toBe(0)
    expect(await versions(page.id)).toEqual([1, 2])
  })

  it('prunes from a scheduled job that needs CRON_SECRET', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    await republish(owner, page.slug)
    await age(page.id, 1, PERSONAL_HISTORY_DAYS + 1)

    expect((await call('/api/cron/history')).status).toBe(404)
    env.cronSecret = 'secret-for-tests'
    expect((await call('/api/cron/history', { bearer: 'wrong' })).status).toBe(404)
    const res = await call('/api/cron/history', { bearer: 'secret-for-tests' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 1 })
  })

  it('does nothing on a self-hosted install', async () => {
    env.selfHosted = true
    env.cronSecret = 'secret-for-tests'
    const owner = await createUser()
    await fillPersonalWorkspace(owner, PERSONAL_PAGES)
    const page = await createPage(owner)
    await republish(owner, page.slug)
    await age(page.id, 1, 365)

    expect(await pruneHistory()).toBe(0)
    expect(await versions(page.id)).toEqual([1, 2])
    expect((await call('/api/cron/history', { bearer: 'secret-for-tests' })).status).toBe(404)
  })
})
