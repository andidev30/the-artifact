import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { publish, restoreVersion } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { Artifact } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { forgetRecentViews } from '../../src/views.js'
import {
  configureWebhooks,
  MAX_ATTEMPTS,
  pruneWebhookDeliveries,
  RETRY_DELAYS_MS,
  runWebhookQueue,
  startWebhookQueue,
  stopWebhookQueue,
  useWebhookQueue,
} from '../../src/webhooks.js'
import { addMember, call, createOrg, createPage, createUser, type TestUser } from './helpers.js'

type Received = { path: string; headers: IncomingHttpHeaders; body: string }

// A local destination that records what it gets and answers with `status`
let server: Server
let base = ''
let received: Received[] = []
let status = 200
let redirectTo = ''
// While set, answers wait for it
let hold: Promise<void> | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      received.push({ path: req.url ?? '', headers: req.headers, body })
      await hold
      if (redirectTo && req.url === '/hook') res.writeHead(302, { location: redirectTo }).end()
      else res.writeHead(status).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  received = []
  status = 200
  redirectTo = ''
  hold = null
  forgetRecentViews()
})

afterEach(async () => {
  env.rateLimits = ''
  configureWebhooks(null)
  await stopWebhookQueue()
  useWebhookQueue(false)
})

function verify(secret: string, header: string, body: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  const expected = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'))
}

async function addHook(user: TestUser, where: string, json: Record<string, unknown>) {
  const res = await call(`${where}/webhooks`, { cookie: user.cookie, json: { url: `${base}/hook`, events: ['page.published'], ...json } })
  expect(res.status).toBe(201)
  return (await res.json()) as { webhook: { id: string; url: string; format: string; events: string[]; enabled: boolean }; secret: string }
}

async function deliveries(user: TestUser, where: string, id: string) {
  const res = await call(`${where}/webhooks/${id}/deliveries`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return ((await res.json()) as { deliveries: { event: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null }[] })
    .deliveries
}

async function openPage(page: Artifact, viewer?: TestUser) {
  const headers = { 'sec-fetch-dest': 'iframe', 'user-agent': 'test-browser' }
  let res = await call(`/api/artifacts/${page.slug}/v/${page.currentVersion}/`, { cookie: viewer?.cookie, headers })
  if (res.status === 302) res = await call(res.headers.get('location')!, { headers })
  expect(res.status).toBe(200)
}

async function org() {
  const owner = await createUser({ name: 'Olive Owner' })
  const o = await createOrg(owner)
  return { owner, org: o, where: `/api/organizations/${o.id}` }
}

describe('events', () => {
  it('signs a JSON body for a publish, with no emails, content or link keys', async () => {
    const { owner, org: o, where } = await org()
    const { secret } = await addHook(owner, where, {})
    const page = await createPage(owner, { organizationId: o.id, title: 'Quarterly report', html: '<h1>secret content</h1>', visibility: 'link' })

    expect(received).toHaveLength(1)
    const [r] = received
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.headers['x-artifact-event']).toBe('page.published')
    expect(r.headers['x-artifact-delivery']).toMatch(/^[0-9a-f-]{36}$/)
    expect(verify(secret, String(r.headers['x-artifact-signature']), r.body)).toBe(true)
    expect(verify('whsec_wrong', String(r.headers['x-artifact-signature']), r.body)).toBe(false)
    expect(JSON.parse(r.body)).toEqual({
      event: 'page.published',
      occurredAt: expect.any(String),
      workspace: { type: 'organization', id: o.id, name: 'Acme Inc' },
      page: { id: page.slug, title: 'Quarterly report', url: `${env.appUrl}/a/${page.slug}` },
      version: 1,
      actor: { name: 'Olive Owner' },
    })
    expect(r.body).not.toContain(owner.email)
    expect(r.body).not.toContain('secret content')

    // A new version, and a restore, are published versions too
    await publish({ userId: owner.id, email: owner.email, organizationId: o.id, clientName: 't', title: 'Quarterly report', slug: page.slug, html: '<p>2</p>' })
    await restoreVersion(page, 1, owner.id)
    expect(received.map((x) => JSON.parse(x.body).version)).toEqual([1, 2, 3])
  })

  it('sends comments with an excerpt, and only the events chosen', async () => {
    const { owner, org: o, where } = await org()
    const member = await createUser({ name: 'Mia' })
    await addMember(o.id, member, 'member')
    await addHook(owner, where, { events: ['comment.created'] })
    const page = await createPage(owner, { organizationId: o.id, visibility: 'organization' })
    expect(received).toHaveLength(0)

    const long = `Looks good. ${'x'.repeat(400)}`
    const res = await call(`/api/artifacts/${page.slug}/comments`, { cookie: member.cookie, json: { body: long } })
    expect(res.status).toBe(201)
    const comment = (await res.json()) as { id: string }
    expect(received).toHaveLength(1)
    const body = JSON.parse(received[0].body)
    expect(body).toMatchObject({ event: 'comment.created', actor: { name: 'Mia' }, version: 1, comment: { id: comment.id } })
    expect(body.comment.excerpt.length).toBeLessThanOrEqual(200)
    expect(body.comment.excerpt).toMatch(/^Looks good\. x+…$/)
  })

  it('sends page opens at most once per page in 10 minutes, and anonymously for link visits', async () => {
    const { owner, org: o, where } = await org()
    const member = await createUser({ name: 'Mia' })
    await addMember(o.id, member, 'member')
    await addHook(owner, where, { events: ['page.opened'] })
    const page = await createPage(owner, { organizationId: o.id, visibility: 'organization' })
    const other = await createPage(owner, { organizationId: o.id, visibility: 'link' })

    await openPage(page, member)
    // Owners opening their own page aren't an audience
    await openPage(page, owner)
    forgetRecentViews()
    const admin = await createUser({ name: 'Ada' })
    await addMember(o.id, admin, 'admin')
    await openPage(page, admin)
    await openPage(other)
    expect(received.map((r) => JSON.parse(r.body))).toEqual([
      expect.objectContaining({ event: 'page.opened', actor: { name: 'Mia' }, page: expect.objectContaining({ id: page.slug }) }),
      expect.objectContaining({ event: 'page.opened', actor: null, page: expect.objectContaining({ id: other.slug }) }),
    ])
  })

  it('formats Slack and Discord messages', async () => {
    const owner = await createUser({ name: 'Sam <admin>' })
    await addHook(owner, '/api/me', { format: 'slack', url: `${base}/slack` })
    await addHook(owner, '/api/me', { format: 'discord', url: `${base}/discord` })
    const page = await createPage(owner, { title: 'Plan *v2* & <notes>' })
    const slack = JSON.parse(received.find((r) => r.path === '/slack')!.body)
    const discord = JSON.parse(received.find((r) => r.path === '/discord')!.body)
    expect(slack).toEqual({ text: `Sam &lt;admin&gt; published <${env.appUrl}/a/${page.slug}|Plan *v2* &amp; &lt;notes&gt;> in Personal` })
    expect(discord).toEqual({
      content: `Sam \\<admin\\> published [Plan \\*v2\\* & \\<notes\\>](${env.appUrl}/a/${page.slug}) in Personal`,
      allowed_mentions: { parse: [] },
    })
  })

  it('sends a duplicated page as published, to the workspace it lands in', async () => {
    const { owner, org: o, where } = await org()
    const source = await createPage(owner)
    await addHook(owner, where, {})
    const res = await call(`/api/artifacts/${source.slug}/duplicate`, { cookie: owner.cookie, json: { workspace: o.id } })
    expect(res.status).toBe(201)
    const copy = (await res.json()) as { slug: string }
    expect(received.map((r) => JSON.parse(r.body))).toEqual([
      expect.objectContaining({ event: 'page.published', version: 1, page: expect.objectContaining({ id: copy.slug }) }),
    ])
  })

  it('keeps workspaces apart', async () => {
    const { owner, org: o } = await org()
    await addHook(owner, '/api/me', {})
    await createPage(owner, { organizationId: o.id })
    expect(received).toHaveLength(0)
    await createPage(owner)
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0].body).workspace).toEqual({ type: 'personal', name: 'Personal' })
  })
})

describe('delivery', () => {
  it('retries with backoff, then gives up, keeping a log', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    status = 500
    const start = Date.now()
    await createPage(owner)
    expect(received).toHaveLength(1)
    let log = await deliveries(owner, '/api/me', webhook.id)
    expect(log).toEqual([
      expect.objectContaining({ event: 'page.published', status: 'pending', attempts: 1, responseStatus: 500, lastError: 'The address answered 500.' }),
    ])

    // Not due yet
    expect(await runWebhookQueue({ now: new Date(start + RETRY_DELAYS_MS[0] / 2) })).toBe(0)
    let at = start
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      at += RETRY_DELAYS_MS[i] + 1000
      expect(await runWebhookQueue({ now: new Date(at) })).toBe(1)
    }
    expect(received).toHaveLength(MAX_ATTEMPTS)
    // All six sent the same body
    expect(new Set(received.map((r) => r.body)).size).toBe(1)
    log = await deliveries(owner, '/api/me', webhook.id)
    expect(log[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(await runWebhookQueue({ now: new Date(at + 24 * 3600_000) })).toBe(0)
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3600_000)
  })

  it('succeeds on a later attempt', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    status = 503
    const start = Date.now()
    await createPage(owner)
    status = 204
    expect(await runWebhookQueue({ now: new Date(start + RETRY_DELAYS_MS[0] + 1000) })).toBe(1)
    expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 204, lastError: null })
  })

  it('only queues from requests when a background process sends', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    useWebhookQueue()
    await createPage(owner)
    expect(received).toHaveLength(0)
    expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({ status: 'pending', attempts: 0 })
    startWebhookQueue({ every: 0 })
    await runWebhookQueue()
    expect(received).toHaveLength(1)
    expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it("hands the first attempt to Vercel's waitUntil, so the request doesn't wait for it", async () => {
    const context = Symbol.for('@vercel/request-context')
    const handed: Promise<unknown>[] = []
    const holder = globalThis as Record<symbol, unknown>
    holder[context] = { get: () => ({ waitUntil: (p: Promise<unknown>) => handed.push(p) }) }
    let release = () => {}
    hold = new Promise((resolve) => {
      release = resolve
    })
    try {
      const owner = await createUser()
      const { webhook } = await addHook(owner, '/api/me', {})
      // The destination hasn't answered, so this returns only because the send was handed off
      await createPage(owner)
      expect(handed).toHaveLength(1)
      expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({ status: 'pending' })

      release()
      await Promise.all(handed)
      expect(received).toHaveLength(1)
      expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({ status: 'delivered', attempts: 1 })
    } finally {
      release()
      delete holder[context]
    }
  })

  it('is retried by the cron job', async () => {
    env.cronSecret = 'cron-secret'
    try {
      const owner = await createUser()
      await addHook(owner, '/api/me', {})
      useWebhookQueue()
      await createPage(owner)
      const res = await call('/api/cron/webhooks', { bearer: 'cron-secret' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ webhooks: 1 })
      expect(received).toHaveLength(1)
    } finally {
      env.cronSecret = ''
    }
  })

  it('does not follow redirects', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    redirectTo = `${base}/elsewhere`
    await createPage(owner)
    expect(received.map((r) => r.path)).toEqual(['/hook'])
    expect((await deliveries(owner, '/api/me', webhook.id))[0].lastError).toMatch(/302, a redirect/)
  })

  it('sends a test on request and drops what waits when turned off', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', { format: 'slack' })
    const res = await call(`/api/me/webhooks/${webhook.id}/test`, { method: 'POST', cookie: owner.cookie, json: {} })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ delivery: { event: 'webhook.test', status: 'delivered', attempts: 1, responseStatus: 200 } })
    expect(JSON.parse(received[0].body).text).toMatch(/Test message/)

    status = 500
    const failed = await (await call(`/api/me/webhooks/${webhook.id}/test`, { method: 'POST', cookie: owner.cookie, json: {} })).json()
    // Tests aren't retried
    expect(failed.delivery).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 500 })

    await createPage(owner)
    const off = await call(`/api/me/webhooks/${webhook.id}`, { method: 'PATCH', cookie: owner.cookie, json: { enabled: false } })
    expect((await off.json()).webhook.enabled).toBe(false)
    expect((await deliveries(owner, '/api/me', webhook.id))[0]).toMatchObject({
      event: 'page.published',
      status: 'failed',
      lastError: 'The webhook was turned off.',
    })
    received = []
    await createPage(owner)
    expect(received).toHaveLength(0)
    expect((await call(`/api/me/webhooks/${webhook.id}/test`, { method: 'POST', cookie: owner.cookie, json: {} })).status).toBe(400)
  })

  it('deletes delivery logs after 14 days', async () => {
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    await createPage(owner)
    expect(await pruneWebhookDeliveries(new Date(Date.now() + 13 * 86_400_000))).toBe(0)
    expect(await pruneWebhookDeliveries(new Date(Date.now() + 15 * 86_400_000))).toBe(1)
    expect(await deliveries(owner, '/api/me', webhook.id)).toEqual([])
  })
})

describe('private networks', () => {
  it('refuses private, loopback, link-local and metadata addresses when saving', async () => {
    const owner = await createUser()
    for (const url of [
      'https://10.0.0.5/hook',
      'https://192.168.1.1/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[fd00::1]/hook',
      'https://localhost/hook',
      'http://example.com/hook',
      'ftp://example.com/hook',
      'https://user:pass@example.com/hook',
    ]) {
      const res = await call('/api/me/webhooks', { cookie: owner.cookie, json: { url, events: ['page.published'] } })
      expect(res.status, url).toBe(400)
      expect((await res.json()).field).toBe('url')
    }
  })

  it('refuses plain http to this machine outside a development server, whatever APP_URL is', async () => {
    expect(env.appUrl.startsWith('http://')).toBe(true)
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})

    configureWebhooks({ allowLocalHttp: false })
    const res = await call('/api/me/webhooks', { cookie: owner.cookie, json: { url: `${base}/other`, events: ['page.published'] } })
    expect(res.status).toBe(400)
    // One saved while it was allowed isn't sent either
    await createPage(owner)
    const [d] = await deliveries(owner, '/api/me', webhook.id)
    expect(d.lastError).toMatch(/Only https/)
    expect(received).toHaveLength(0)
  })

  it('gives the same error for a name that is not found as for one on a private network', async () => {
    const owner = await createUser()
    configureWebhooks({
      lookup: async (host) => {
        if (host === 'inside.example.com') return [{ address: '10.1.2.3', family: 4 }]
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
      },
    })
    const inside = (await addHook(owner, '/api/me', { url: 'https://inside.example.com/hook' })).webhook
    const missing = (await addHook(owner, '/api/me', { url: 'https://missing.example.com/hook' })).webhook
    await createPage(owner)
    const [a] = await deliveries(owner, '/api/me', inside.id)
    const [b] = await deliveries(owner, '/api/me', missing.id)
    expect(a.lastError?.replace('inside', 'missing')).toBe(b.lastError)
    expect(b.lastError).toMatch(/could not be found, or it is on a private network/)
  })

  it('checks where a name resolves every time it sends', async () => {
    const owner = await createUser()
    const names: Record<string, string> = { 'hooks.example.com': '127.0.0.1', 'meta.example.com': '169.254.169.254', 'mixed.example.com': '10.1.2.3' }
    configureWebhooks({
      lookup: async (host) =>
        host === 'mixed.example.com'
          ? [
              { address: '93.184.215.14', family: 4 },
              { address: names[host], family: 4 },
            ]
          : [{ address: names[host], family: 4 }],
    })
    const hooks = []
    for (const host of Object.keys(names)) hooks.push((await addHook(owner, '/api/me', { url: `https://${host}/hook` })).webhook)
    await createPage(owner)
    for (const hook of hooks) {
      const [d] = await deliveries(owner, '/api/me', hook.id)
      expect(d.lastError).toMatch(/private network or a reserved address/)
      expect(d.responseStatus).toBeNull()
    }
    expect(received).toHaveLength(0)
  })
})

describe('who manages webhooks', () => {
  it('lets organization owners and admins manage them, and nobody else', async () => {
    const { owner, org: o, where } = await org()
    const admin = await createUser()
    const member = await createUser()
    const outsider = await createUser()
    await addMember(o.id, admin, 'admin')
    await addMember(o.id, member, 'member')
    const { webhook } = await addHook(admin, where, {})

    for (const user of [member, outsider]) {
      expect((await call(`${where}/webhooks`, { cookie: user.cookie })).status).toBe(404)
      expect((await call(`${where}/webhooks`, { cookie: user.cookie, json: { url: 'https://example.com', events: ['page.published'] } })).status).toBe(404)
      expect((await call(`${where}/webhooks/${webhook.id}`, { method: 'PATCH', cookie: user.cookie, json: { enabled: false } })).status).toBe(404)
      expect((await call(`${where}/webhooks/${webhook.id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(404)
      expect((await call(`${where}/webhooks/${webhook.id}/test`, { method: 'POST', cookie: user.cookie, json: {} })).status).toBe(404)
      expect((await call(`${where}/webhooks/${webhook.id}/deliveries`, { cookie: user.cookie })).status).toBe(404)
    }
    // Someone else's personal webhook looks missing too
    expect((await call(`/api/me/webhooks/${webhook.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(404)
    expect((await call('/api/organizations/not-an-id/webhooks', { cookie: owner.cookie })).status).toBe(404)

    const list = await (await call(`${where}/webhooks`, { cookie: owner.cookie })).json()
    expect(list.webhooks.map((h: { id: string }) => h.id)).toEqual([webhook.id])
    expect((await call(`${where}/webhooks/${webhook.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect((await (await call(`${where}/webhooks`, { cookie: owner.cookie })).json()).webhooks).toEqual([])
  })

  it('shows the secret only once and stores it sealed', async () => {
    const owner = await createUser()
    const { webhook, secret } = await addHook(owner, '/api/me', {})
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    const listed = await (await call('/api/me/webhooks', { cookie: owner.cookie })).text()
    const changed = await (await call(`/api/me/webhooks/${webhook.id}`, { method: 'PATCH', cookie: owner.cookie, json: { format: 'discord' } })).text()
    for (const text of [listed, changed]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain('"secret"')
    }
    const [row] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, webhook.id))
    expect(row.secret).not.toContain(secret.slice(6))
    expect(row.secret).toMatch(/^v1\./)
  })

  it('checks what is saved', async () => {
    const owner = await createUser()
    const bad = async (json: Record<string, unknown>, field: string) => {
      const res = await call('/api/me/webhooks', { cookie: owner.cookie, json: { url: `${base}/hook`, events: ['page.published'], ...json } })
      expect(res.status).toBe(400)
      expect((await res.json()).field).toBe(field)
    }
    await bad({ events: [] }, 'events')
    await bad({ events: ['page.deleted'] }, 'events')
    await bad({ format: 'teams' }, 'format')
    await bad({ url: '' }, 'url')
    await bad({ enabled: 'yes' }, 'enabled')
  })

  it('limits how many webhooks one account adds and tests', async () => {
    env.rateLimits = 'webhook=2/1h'
    const owner = await createUser()
    const { webhook } = await addHook(owner, '/api/me', {})
    expect((await call(`/api/me/webhooks/${webhook.id}/test`, { method: 'POST', cookie: owner.cookie, json: {} })).status).toBe(200)
    const res = await call(`/api/me/webhooks/${webhook.id}/test`, { method: 'POST', cookie: owner.cookie, json: {} })
    expect(res.status).toBe(429)
  })
})
