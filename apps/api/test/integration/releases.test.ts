import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { RELEASES_API, releaseStatus } from '../../src/releases.js'
import { call, createUser } from './helpers.js'

vi.mock('../../src/version.js', () => ({ VERSION: '0.2.0' }))

const original = { selfHosted: env.selfHosted, releaseCheck: env.releaseCheck }
const DAY_MS = 24 * 60 * 60 * 1000

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/andidev30/the-artifact/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
})

let github: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function answer(body: unknown, status = 200) {
  github.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  env.selfHosted = true
  env.releaseCheck = true
  const realFetch = globalThis.fetch
  github = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com/')) return github(url, init)
    return realFetch(input, init)
  })
})

afterEach(() => {
  env.selfHosted = original.selfHosted
  env.releaseCheck = original.releaseCheck
  vi.restoreAllMocks()
})

describe('release notice', () => {
  it('tells admins about a newer release, with a link to its notes', async () => {
    answer([release('v0.10.0'), release('v0.3.0'), release('v0.11.0-rc.1', { prerelease: true }), release('cli-v1.0.0')])
    const admin = await createUser({ admin: true })
    const res = await call('/api/admin/release', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      current: '0.2.0',
      newer: { version: '0.10.0', url: 'https://github.com/andidev30/the-artifact/releases/tag/v0.10.0' },
    })
  })

  it('sends nothing that identifies the install', async () => {
    answer([release('v0.3.0')])
    await releaseStatus()
    expect(github).toHaveBeenCalledTimes(1)
    const [url, init] = github.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(RELEASES_API)
    expect(new URL(url).search).toBe('?per_page=30')
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json' })
    expect(init.body).toBeUndefined()
  })

  it('shows nothing when this server runs the newest release or a later one', async () => {
    answer([release('v0.2.0'), release('v0.1.0')])
    expect(await releaseStatus()).toEqual({ current: '0.2.0', newer: null })
    await db.update(schema.releaseCheck).set({ latestVersion: '0.1.5', releaseUrl: 'https://github.com/andidev30/the-artifact/releases/tag/v0.1.5' })
    expect((await releaseStatus()).newer).toBeNull()
  })

  it('asks GitHub at most once a day, also from several requests at once', async () => {
    answer([release('v0.3.0')])
    const now = new Date()
    const results = await Promise.all([releaseStatus(now), releaseStatus(now), releaseStatus(now)])
    expect(github).toHaveBeenCalledTimes(1)
    expect(results.some((r) => r.newer?.version === '0.3.0')).toBe(true)

    answer([release('v0.4.0')])
    const later = await releaseStatus(new Date(now.getTime() + DAY_MS - 60_000))
    expect(github).toHaveBeenCalledTimes(1)
    expect(later.newer?.version).toBe('0.3.0')

    const nextDay = await releaseStatus(new Date(now.getTime() + DAY_MS))
    expect(github).toHaveBeenCalledTimes(2)
    expect(nextDay.newer?.version).toBe('0.4.0')
  })

  it('keeps the last answer and waits a day when GitHub fails', async () => {
    answer([release('v0.3.0')])
    const now = new Date()
    await releaseStatus(now)

    github.mockRejectedValue(new Error('network down'))
    const failed = await releaseStatus(new Date(now.getTime() + DAY_MS))
    expect(failed.newer?.version).toBe('0.3.0')
    expect(github).toHaveBeenCalledTimes(2)

    await releaseStatus(new Date(now.getTime() + DAY_MS + 60_000))
    expect(github).toHaveBeenCalledTimes(2)
  })

  it('never breaks the admin page when GitHub answers with an error', async () => {
    answer({ message: 'API rate limit exceeded' }, 403)
    const admin = await createUser({ admin: true })
    const res = await call('/api/admin/release', { cookie: admin.cookie })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ current: '0.2.0', newer: null })
  })

  it('makes no request with RELEASE_CHECK=false', async () => {
    env.releaseCheck = false
    answer([release('v0.3.0')])
    const admin = await createUser({ admin: true })
    const res = await call('/api/admin/release', { cookie: admin.cookie })
    expect(await res.json()).toEqual({ current: '0.2.0', newer: null })
    expect(github).not.toHaveBeenCalled()
    expect(await db.select().from(schema.releaseCheck)).toHaveLength(0)
  })

  it('does nothing on the hosted service', async () => {
    env.selfHosted = false
    answer([release('v0.3.0')])
    expect(await releaseStatus()).toEqual({ current: '0.2.0', newer: null })
    expect(github).not.toHaveBeenCalled()
    expect(await db.select().from(schema.releaseCheck)).toHaveLength(0)
  })

  it('is for instance admins only', async () => {
    answer([release('v0.3.0')])
    const user = await createUser()
    expect((await call('/api/admin/release', { cookie: user.cookie })).status).toBe(403)
    expect((await call('/api/admin/release')).status).toBe(401)
    expect(github).not.toHaveBeenCalled()
  })
})
