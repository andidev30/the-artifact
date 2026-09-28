import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { deleteExpiredLimits } from '../../src/limits.js'
import { call, callTool, connectAgent, createOrg, createPage, createUser, REDIRECT_URI, slugFrom, type TestUser } from './helpers.js'

// Tests run in-process with no connection address, so each request says where it comes from in
// X-Forwarded-For, trusted as if one proxy were in front
const original = { rateLimits: env.rateLimits, trustProxy: env.trustProxy, host: env.smtp.host, cronSecret: env.cronSecret }

beforeEach(() => {
  env.trustProxy = 1
})

afterEach(() => {
  env.rateLimits = original.rateLimits
  env.trustProxy = original.trustProxy
  env.smtp.host = original.host
  env.cronSecret = original.cronSecret
})

const from = (ip: string) => ({ 'x-forwarded-for': ip })

async function expectTooMany(res: Response, message: RegExp) {
  expect(res.status).toBe(429)
  const wait = Number(res.headers.get('retry-after'))
  expect(wait).toBeGreaterThan(0)
  const body = (await res.json()) as { error: string }
  expect(body.error).toMatch(message)
  return { wait, body }
}

// Sign-in links to one address are also spaced 60 seconds apart; make the last one older than that
async function ageLinks() {
  await db.update(schema.emailTokens).set({ createdAt: new Date(Date.now() - 120_000) })
}

const sendLink = (email: string, ip = '203.0.113.1') => call('/api/auth/email', { json: { email, intent: 'login' }, headers: from(ip) })

describe('sign-in links', () => {
  it('limits links to one address', async () => {
    env.rateLimits = 'sign-in-link=2/1h'
    for (let i = 0; i < 2; i++) {
      expect((await sendLink('pat@example.com')).status).toBe(204)
      await ageLinks()
    }
    const { wait } = await expectTooMany(await sendLink('pat@example.com'), /^Too many sign-in links were sent to this address\. Try again in 60 minutes\.$/)
    expect(wait).toBeLessThanOrEqual(3600)
    expect((await sendLink('someone-else@example.com')).status).toBe(204)
  })

  it('limits links asked for from one network', async () => {
    env.rateLimits = 'sign-in-link-ip=2/1h'
    expect((await sendLink('a@example.com')).status).toBe(204)
    expect((await sendLink('b@example.com')).status).toBe(204)
    await expectTooMany(await sendLink('c@example.com'), /from your network/)
    expect((await sendLink('c@example.com', '198.51.100.7')).status).toBe(204)
  })
})

describe('password sign-in', () => {
  beforeEach(() => {
    env.smtp.host = ''
  })

  const login = (email: string, password: string, ip = '203.0.113.1') => call('/api/auth/password/login', { json: { email, password }, headers: from(ip) })

  async function withPassword(user: TestUser, password: string) {
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(schema.users.id, user.id))
  }

  it('locks an address after wrong passwords, and a right one before that resets the count', async () => {
    env.rateLimits = 'password=3/15m'
    await withPassword(await createUser({ email: 'guess@example.com' }), 'right password')
    for (let i = 0; i < 2; i++) expect((await login('guess@example.com', `wrong ${i}`)).status).toBe(401)
    expect((await login('guess@example.com', 'right password')).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await login('guess@example.com', `wrong ${i}`, `198.51.100.${i}`)).status).toBe(401)
    const { body } = await expectTooMany(
      await login('guess@example.com', 'right password'),
      /^Too many wrong passwords for this address\. Try again in 15 minutes/,
    )
    expect(body).toMatchObject({ code: 'too_many_attempts' })
  })

  it('limits attempts from one network, sign-ups included', async () => {
    env.rateLimits = 'password-ip=2/15m'
    expect((await login('a@example.com', 'whatever123')).status).toBe(401)
    expect((await call('/api/auth/password/sign-up', { json: { email: 'b@example.com', password: 'long enough' }, headers: from('203.0.113.1') })).status).toBe(
      201,
    )
    await expectTooMany(await login('a@example.com', 'whatever123'), /^Too many sign-in attempts from your network\. Try again in 15 minutes\.$/)
    expect((await login('a@example.com', 'whatever123', '198.51.100.1')).status).toBe(401)
  })

  it('checks no more wrong passwords for an address than the limit when they arrive at the same time', async () => {
    await withPassword(await createUser({ email: 'burst@example.com' }), 'right password')
    const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => login('burst@example.com', `wrong ${i}`, `198.51.100.${i}`).then((r) => r.status)))
    expect(statuses.filter((s) => s === 401)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(30)
  })

  it('limits wrong current passwords when changing the password, together with sign-in', async () => {
    env.rateLimits = 'password=3/15m'
    const user = await createUser({ email: 'change@example.com' })
    await withPassword(user, 'right password')
    const change = (currentPassword: string) =>
      call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { currentPassword, password: 'a new password' } })
    expect((await change('wrong 1')).status).toBe(400)
    // A right one clears the count
    expect((await login('change@example.com', 'right password')).status).toBe(200)
    expect((await change('wrong 2')).status).toBe(400)
    expect((await login('change@example.com', 'wrong 3')).status).toBe(401)
    expect((await change('wrong 4')).status).toBe(400)
    const { body } = await expectTooMany(await change('right password'), /^Too many wrong passwords\. Try again in 15 minutes\.$/)
    expect(body).toMatchObject({ code: 'too_many_attempts', field: 'currentPassword' })
    await expectTooMany(await login('change@example.com', 'right password'), /^Too many wrong passwords for this address/)
  })

  it('checks no more wrong current passwords than the limit when they arrive at the same time', async () => {
    const user = await createUser()
    await withPassword(user, 'right password')
    const statuses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { currentPassword: `wrong ${i}`, password: 'a new password' } }).then(
          (r) => r.status,
        ),
      ),
    )
    expect(statuses.filter((s) => s === 400)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(15)
  })
})

describe('agent registration', () => {
  const register = (ip: string) => call('/oauth/register', { json: { client_name: 'claude-code', redirect_uris: [REDIRECT_URI] }, headers: from(ip) })

  it('limits client registrations from one network, with a message OAuth clients show', async () => {
    env.rateLimits = 'oauth-register-ip=2/1h'
    expect((await register('203.0.113.1')).status).toBe(201)
    expect((await register('203.0.113.1')).status).toBe(201)
    const { body } = await expectTooMany(await register('203.0.113.1'), /^Too many agents were connected from your network/)
    expect(body).toMatchObject({ error_description: body.error })
    expect((await register('198.51.100.1')).status).toBe(201)
  })
})

describe('invitations and shares', () => {
  it('limits how many people one account invites', async () => {
    env.rateLimits = 'invite=2/1h'
    const owner = await createUser()
    const org = await createOrg(owner)
    const invite = (email: string) => call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email, role: 'member' } })
    expect((await invite('a@example.com')).status).toBe(201)
    expect((await invite('b@example.com')).status).toBe(201)
    await expectTooMany(await invite('c@example.com'), /^You have invited a lot of people in a short time\. Try again in/)
    expect(await db.select().from(schema.invitations).where(eq(schema.invitations.email, 'c@example.com'))).toEqual([])

    // Another admin of the same organization has a count of their own
    const other = await createUser()
    await db.insert(schema.memberships).values({ organizationId: org.id, userId: other.id, role: 'admin' })
    expect((await call(`/api/organizations/${org.id}/invitations`, { cookie: other.cookie, json: { email: 'c@example.com', role: 'member' } })).status).toBe(
      201,
    )
  })

  it('counts every person a page is shared with by email, in the web app and by agents', async () => {
    env.rateLimits = 'invite=3/1h'
    const owner = await createUser()
    const page = await createPage(owner)
    const share = (emails: string[], notify = true) =>
      call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails, role: 'viewer', notify } })
    expect((await share(['a@example.com', 'b@example.com'])).status).toBe(200)
    // Without an email, nobody is sent anything, so it doesn't count
    expect((await share(['quiet@example.com'], false)).status).toBe(200)
    await expectTooMany(await share(['c@example.com', 'd@example.com']), /invited a lot of people/)

    const token = (await connectAgent(owner)).access_token
    expect((await callTool(token, 'share_artifact', { artifact_id: page.slug, emails: ['e@example.com'] })).isError).toBe(false)
    const refused = await callTool(token, 'share_artifact', { artifact_id: page.slug, emails: ['f@example.com'] })
    expect(refused).toEqual({
      isError: true,
      text: expect.stringMatching(/^This account is past this server's limit of 3 people invited or shared with per hour\./),
    })
  })
})

describe('contact sales', () => {
  let n = 0
  const form = () => {
    n += 1
    return { name: 'Dana', email: `dana${n}@acme.example`, company: 'Acme', teamSize: '1-10', message: 'We would like to talk about Enterprise.' }
  }

  it('answers with Retry-After per address, and limits one network too', async () => {
    const body = form()
    for (let i = 0; i < 3; i++) expect((await call('/api/contact-sales', { json: body, headers: from('203.0.113.1') })).status).toBe(204)
    await expectTooMany(await call('/api/contact-sales', { json: body, headers: from('203.0.113.1') }), /We already have a few messages from this address/)

    env.rateLimits = 'contact-ip=1/1h'
    expect((await call('/api/contact-sales', { json: form(), headers: from('198.51.100.1') })).status).toBe(204)
    await expectTooMany(await call('/api/contact-sales', { json: form(), headers: from('198.51.100.1') }), /^Too many messages were sent from your network/)
  })
})

describe('agents', () => {
  it('limits tool calls per account with an error the agent can read', async () => {
    env.rateLimits = 'mcp=3/10m'
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    for (let i = 0; i < 3; i++) expect((await callTool(token, 'list_artifacts', {})).isError).toBe(false)
    const refused = await callTool(token, 'list_artifacts', {})
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/^This account is past this server's limit of 3 tool calls per 10 minutes\. Try again in 10 minutes\.$/)

    // Per account, whichever agent calls
    const other = await createUser()
    expect((await callTool((await connectAgent(other)).access_token, 'list_artifacts', {})).isError).toBe(false)
  })

  it('limits publishes per account, while other tools keep working', async () => {
    env.rateLimits = 'publish=2/1h'
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    const first = await callTool(token, 'publish_artifact', { title: 'One', html: '<p>1</p>' })
    const slug = slugFrom(first.text)
    expect((await callTool(token, 'publish_artifact', { title: 'One', html: '<p>2</p>', artifact_id: slug })).isError).toBe(false)
    const refused = await callTool(token, 'restore_version', { artifact_id: slug, version: 1 })
    expect(refused).toEqual({ isError: true, text: expect.stringMatching(/limit of 2 new pages and versions per hour\. Try again in 60 minutes\.$/) })
    expect(await db.select().from(schema.artifactVersions)).toHaveLength(2)
    expect((await callTool(token, 'list_versions', { artifact_id: slug })).isError).toBe(false)
  })
})

describe('turning limits off', () => {
  it('RATE_LIMITS=off lets everything through', async () => {
    env.rateLimits = 'off'
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    for (let i = 0; i < 12; i++) {
      expect((await sendLink(`person${i}@example.com`)).status).toBe(204)
      expect((await call('/oauth/register', { json: { redirect_uris: [REDIRECT_URI] }, headers: from('203.0.113.1') })).status).toBe(201)
    }
    for (let i = 0; i < 4; i++) {
      expect((await sendLink('same@example.com')).status).toBe(204)
      await ageLinks()
    }
    for (let i = 0; i < 5; i++) expect((await callTool(token, 'publish_artifact', { title: `Page ${i}`, html: '<p>x</p>' })).isError).toBe(false)
    expect(await db.select().from(schema.rateLimits)).toEqual([])
  })

  it('one limit can be turned off while the others stay', async () => {
    env.rateLimits = 'mcp=off,publish=1/1h'
    const token = (await connectAgent(await createUser())).access_token
    for (let i = 0; i < 3; i++) expect((await callTool(token, 'list_artifacts', {})).isError).toBe(false)
    expect((await callTool(token, 'publish_artifact', { title: 'A', html: '<p>a</p>' })).isError).toBe(false)
    expect((await callTool(token, 'publish_artifact', { title: 'B', html: '<p>b</p>' })).isError).toBe(true)
  })

  it('without a known client address, per-network limits do not apply', async () => {
    env.trustProxy = 0
    env.rateLimits = 'oauth-register-ip=1/1h'
    for (let i = 0; i < 3; i++) {
      // A client can write anything in X-Forwarded-For, so without TRUST_PROXY it is ignored
      expect((await call('/oauth/register', { json: { redirect_uris: [REDIRECT_URI] }, headers: from('203.0.113.1') })).status).toBe(201)
    }
  })
})

describe('windows', () => {
  it('start again once over, and old counters are cleared by the sweep', async () => {
    env.rateLimits = 'oauth-register-ip=1/1h'
    const register = () => call('/oauth/register', { json: { redirect_uris: [REDIRECT_URI] }, headers: from('203.0.113.1') })
    expect((await register()).status).toBe(201)
    expect((await register()).status).toBe(429)
    await db.update(schema.rateLimits).set({ resetsAt: sql`now() - interval '1 second'` })
    expect((await register()).status).toBe(201)
    expect((await register()).status).toBe(429)

    await db.update(schema.rateLimits).set({ resetsAt: sql`now() - interval '1 second'` })
    env.cronSecret = 'a-long-random-secret'
    const res = await call('/api/cron/sweep', { bearer: 'a-long-random-secret' })
    expect(await res.json()).toMatchObject({ rateLimits: 1 })
    expect(await db.select().from(schema.rateLimits)).toEqual([])
    expect(await deleteExpiredLimits()).toBe(0)
  })

  it('count requests that arrive at the same time exactly once each', async () => {
    env.rateLimits = 'oauth-register-ip=5/1h'
    const results = await Promise.all(
      Array.from({ length: 8 }, () => call('/oauth/register', { json: { redirect_uris: [REDIRECT_URI] }, headers: from('203.0.113.1') })),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(5)
    expect(results.filter((r) => r.status === 429)).toHaveLength(3)
  })

  it('store no addresses, only their hashes', async () => {
    await sendLink('private@example.com', '203.0.113.99')
    const rows = await db.select().from(schema.rateLimits)
    expect(rows.map((r) => r.bucket).sort()).toEqual(['sign-in-link', 'sign-in-link-ip'])
    for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toMatch(/private@example\.com|203\.0\.113\.99/)
  })
})
