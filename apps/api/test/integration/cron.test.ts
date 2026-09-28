import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { configureCron } from '../../src/routes/cron.js'
import { staleIds } from '../../src/search.js'
import { runWebhookQueue, useWebhookQueue } from '../../src/webhooks.js'
import { call, createPage, createUser } from './helpers.js'

let server: Server
let base = ''
let received = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      received += 1
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

afterEach(() => {
  env.cronSecret = ''
  configureCron(null)
  useWebhookQueue(false)
  received = 0
})

// A page whose publish queued a webhook delivery nobody has sent, and whose words aren't indexed
async function pendingWork() {
  const owner = await createUser()
  const hook = await call('/api/me/webhooks', { cookie: owner.cookie, json: { url: `${base}/hook`, events: ['page.published'] } })
  expect(hook.status).toBe(201)
  useWebhookQueue()
  const page = await createPage(owner)
  useWebhookQueue(false)
  await db.delete(schema.artifactSearch)
  expect(await staleIds()).toEqual([page.id])
  return page
}

describe('scheduled jobs', () => {
  it("don't exist without CRON_SECRET", async () => {
    expect((await call('/api/cron/sweep')).status).toBe(404)
    expect((await call('/api/cron/sweep', { bearer: '' })).status).toBe(404)
  })

  it('need the secret as a bearer token', async () => {
    env.cronSecret = 'a-long-random-secret'
    expect((await call('/api/cron/sweep')).status).toBe(404)
    expect((await call('/api/cron/sweep', { bearer: 'wrong' })).status).toBe(404)
    expect((await call('/api/cron/sweep', { headers: { authorization: 'a-long-random-secret' } })).status).toBe(404)

    const res = await call('/api/cron/sweep', { bearer: 'a-long-random-secret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ checked: expect.any(Number), deleted: expect.any(Number), uploads: expect.any(Number) })
  })

  it('start no new work once the run is out of time, and leave it for the next run', async () => {
    env.cronSecret = 'a-long-random-secret'
    const page = await pendingWork()

    configureCron({ runMs: 0 })
    const late = await call('/api/cron/sweep', { bearer: env.cronSecret })
    expect(late.status).toBe(200)
    expect(await late.json()).toMatchObject({ checked: 0, deleted: 0, uploads: 0, exportSteps: 0, webhooks: 0, indexed: 0 })
    expect(await (await call('/api/cron/webhooks', { bearer: env.cronSecret })).json()).toEqual({ webhooks: 0 })
    expect(received).toBe(0)
    expect(await staleIds()).toEqual([page.id])

    configureCron(null)
    const next = await call('/api/cron/sweep', { bearer: env.cronSecret })
    expect(await next.json()).toMatchObject({ webhooks: 1, indexed: 1, checked: expect.any(Number) })
    expect(received).toBe(1)
    expect(await staleIds()).toEqual([])
  })

  it('send no batch of webhooks after the deadline', async () => {
    await pendingWork()
    expect(await runWebhookQueue({ deadline: Date.now() - 1 })).toBe(0)
    expect(received).toBe(0)
    expect(await runWebhookQueue({ deadline: Date.now() + 30_000 })).toBe(1)
    expect(received).toBe(1)
  })
})
