import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackingSettled } from '../../src/analytics.js'
import { db, schema } from '../../src/db/index.js'
import { funnel, pruneProductEvents } from '../../src/ee/analytics.js'
import { env } from '../../src/env.js'
import { runPruners } from '../../src/gc.js'
import { sendSignInLink } from '../../src/mail.js'
import { addMember, call, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const original = { selfHosted: env.selfHosted }
const DAY = 24 * 60 * 60 * 1000

afterEach(async () => {
  await trackingSettled()
  env.selfHosted = original.selfHosted
})

async function events() {
  await trackingSettled()
  return db.select().from(schema.productEvents).orderBy(schema.productEvents.createdAt)
}

async function signUpWithEmail(email: string) {
  expect((await call('/api/auth/email', { json: { email } })).status).toBe(204)
  const link = new URL(vi.mocked(sendSignInLink).mock.calls.at(-1)![1])
  const res = await call('/api/auth/email/confirm', { json: { token: link.searchParams.get('token') } })
  expect(res.status).toBe(200)
  const [user] = await db.select().from(schema.users).where(sql`${schema.users.email} = ${email}`)
  return { id: user.id, email, name: null, cookie: res.headers.getSetCookie()[0].split(';')[0] } as TestUser
}

async function publishTwice(user: TestUser) {
  const page = await createPage(user)
  await createPage(user)
  return page
}

// Every step once, through the API where the app goes through it
async function wholeFunnel() {
  const user = await signUpWithEmail('new@example.com')
  expect((await call('/api/onboarding/personal', { method: 'POST', cookie: user.cookie })).status).toBe(204)
  await connectAgent(user)
  await connectAgent(user)
  const page = await publishTwice(user)
  expect((await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: user.cookie, json: { visibility: 'link' } })).status).toBe(200)
  expect((await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: user.cookie, json: { emails: 'friend@example.com', role: 'viewer' } })).ok).toBe(
    true,
  )
  return { user, page }
}

describe('product events on the hosted service', () => {
  it('records each funnel step once per account', async () => {
    const { user } = await wholeFunnel()
    const rows = await events()
    expect(rows.map((r) => [r.event, r.detail])).toEqual([
      ['signed_up', 'email_link'],
      ['onboarded', 'personal'],
      ['agent_connected', 'oauth'],
      ['page_published', null],
      ['page_shared', 'link'],
    ])
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([user.id]))

    // Signing in again, another agent, another publish: still one row per step
    await createPage(user)
    const token = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI', expiresInDays: 30 } })
    expect(token.status).toBe(201)
    expect((await events()).length).toBe(5)
  })

  it('counts every publish per day without saying who', async () => {
    const a = await createUser()
    const b = await createUser()
    await publishTwice(a)
    await createPage(b)
    await trackingSettled()
    const days = await db.select().from(schema.productDailyCounts)
    expect(days).toEqual([{ day: new Date().toISOString().slice(0, 10), event: 'page_published', count: 3 }])
  })

  it('records how each person first shared a page', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const page = await createPage(owner, { organizationId: org.id, visibility: 'private' })
    expect(
      (await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'friend@example.com', role: 'viewer' } })).ok,
    ).toBe(true)
    const colleague = await createUser()
    await addMember(org.id, colleague, 'member')
    const theirs = await createPage(colleague, { organizationId: org.id, visibility: 'private' })
    expect((await call(`/api/artifacts/${theirs.slug}`, { method: 'PATCH', cookie: colleague.cookie, json: { visibility: 'organization' } })).status).toBe(200)
    // A new page open to its organization by default isn't a share anybody chose
    const quiet = await createUser()
    await createPage(quiet, { organizationId: org.id })
    const rows = (await events()).filter((r) => r.event === 'page_shared')
    expect(rows.map((r) => [r.userId, r.detail])).toEqual([
      [owner.id, 'person'],
      [colleague.id, 'organization'],
    ])
  })

  it('keeps no page content, titles, email addresses or IP addresses', async () => {
    await wholeFunnel()
    await trackingSettled()
    const dump = JSON.stringify([...(await db.execute(sql`select * from product_events`)), ...(await db.execute(sql`select * from product_daily_counts`))])
    expect(dump).not.toMatch(/@example\.com|Test page|Hello|127\.0\.0\.1|claude-code/)
    const columns = await db.execute<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_name in ('product_events', 'product_daily_counts') order by 1, 2`,
    )
    expect([...columns].map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'product_daily_counts.count',
      'product_daily_counts.day',
      'product_daily_counts.event',
      'product_events.created_at',
      'product_events.detail',
      'product_events.event',
      'product_events.id',
      'product_events.user_id',
    ])
  })

  it("deletes a person's events with their account", async () => {
    const { user } = await wholeFunnel()
    const stays = await createUser()
    await createPage(stays)
    await trackingSettled()
    expect((await call('/api/me', { method: 'DELETE', cookie: user.cookie, json: { confirmEmail: user.email } })).status).toBe(204)
    const rows = await events()
    expect(rows.map((r) => r.userId)).toEqual([stays.id])
  })

  it('prunes events after 13 months, also from the storage sweep', async () => {
    const user = await createUser()
    await createPage(user)
    await trackingSettled()
    const old = new Date(Date.now() - 400 * DAY)
    await db.update(schema.productEvents).set({ createdAt: old })
    await db.insert(schema.productDailyCounts).values({ day: old.toISOString().slice(0, 10), event: 'page_published', count: 4 })
    const recent = await createUser()
    await createPage(recent)
    await trackingSettled()

    expect(await pruneProductEvents(new Date(Date.now() + 1000))).toBe(2)
    expect((await events()).map((r) => r.userId)).toEqual([recent.id])
    expect((await db.select().from(schema.productDailyCounts)).map((d) => d.count)).toEqual([2])

    await db.update(schema.productEvents).set({ createdAt: old })
    await runPruners()
    expect(await events()).toEqual([])
  })

  it('shows the funnel of recent sign-ups to instance admins', async () => {
    await wholeFunnel()
    // An account from before the funnel was recorded doesn't count, even when it publishes
    await createPage(await createUser())
    const admin = await createUser({ admin: true })
    const res = await call('/api/admin/analytics/funnel', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.windows).toEqual([7, 30, 90])
    expect(body.steps).toEqual([
      { event: 'signed_up', counts: [1, 1, 1] },
      { event: 'onboarded', counts: [1, 1, 1] },
      { event: 'agent_connected', counts: [1, 1, 1] },
      { event: 'page_published', counts: [1, 1, 1] },
      { event: 'page_shared', counts: [1, 1, 1] },
    ])
    expect(body.signUpMethods).toContainEqual({ method: 'email_link', counts: [1, 1, 1] })
    expect(body.publishes).toEqual([3, 3, 3])
    expect(body.retentionMonths).toBe(13)
  })

  it('puts sign-ups in the windows they happened in', async () => {
    const user = await createUser()
    await db.insert(schema.productEvents).values([
      { userId: user.id, event: 'signed_up', detail: 'google', createdAt: new Date(Date.now() - 20 * DAY) },
      { userId: user.id, event: 'onboarded', detail: 'personal', createdAt: new Date(Date.now() - 19 * DAY) },
    ])
    const result = await funnel()
    expect(result.steps.slice(0, 3).map((s) => s.counts)).toEqual([
      [0, 1, 1],
      [0, 1, 1],
      [0, 0, 0],
    ])
    expect(result.signUpMethods).toContainEqual({ method: 'google', counts: [0, 1, 1] })
  })

  it('answers 404 to everyone but instance admins', async () => {
    const person = await createUser()
    expect((await call('/api/admin/analytics/funnel')).status).toBe(404)
    expect((await call('/api/admin/analytics/funnel', { cookie: person.cookie })).status).toBe(404)
  })
})

describe('product events on a self-hosted install', () => {
  it('records nothing and has no funnel', async () => {
    env.selfHosted = true
    const admin = await createUser({ admin: true })
    const user = await signUpWithEmail('someone@example.com')
    await connectAgent(user)
    const page = await createPage(user)
    await call(`/api/artifacts/${page.slug}`, { method: 'PATCH', cookie: user.cookie, json: { visibility: 'link' } })
    expect(await events()).toEqual([])
    expect(await db.select().from(schema.productDailyCounts)).toEqual([])
    expect((await call('/api/admin/analytics/funnel', { cookie: admin.cookie })).status).toBe(404)
  })
})
