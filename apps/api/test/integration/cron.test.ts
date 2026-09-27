import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../../src/env.js'
import { call } from './helpers.js'

describe('scheduled jobs', () => {
  afterEach(() => {
    env.cronSecret = ''
  })

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
})
