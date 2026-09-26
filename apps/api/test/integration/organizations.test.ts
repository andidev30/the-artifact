import { describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import { call, createOrg, createUser } from './helpers.js'

describe('onboarding', () => {
  it('personal workspace marks the person onboarded', async () => {
    const user = await createUser({ onboarded: false })
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).onboarded).toBe(false)
    expect((await call('/api/onboarding/personal', { method: 'POST', cookie: user.cookie })).status).toBe(204)
    expect((await (await call('/api/me', { cookie: user.cookie })).json()).onboarded).toBe(true)
  })

  it('needs a session', async () => {
    expect((await call('/api/onboarding/personal', { method: 'POST' })).status).toBe(401)
    expect((await call('/api/organizations', { json: { name: 'Acme', slug: 'acme' } })).status).toBe(401)
    expect((await call('/api/organizations/slug-available?slug=acme')).status).toBe(401)
  })
})

describe('organizations', () => {
  it('creating one makes you its owner and finishes onboarding', async () => {
    const user = await createUser({ onboarded: false })
    const res = await call('/api/organizations', { cookie: user.cookie, json: { name: '  Acme Inc  ', slug: ' ACME ' } })
    expect(res.status).toBe(201)
    const org = await res.json()
    expect(org).toMatchObject({ name: 'Acme Inc', slug: 'acme', role: 'owner' })

    const me = await (await call('/api/me', { cookie: user.cookie })).json()
    expect(me.onboarded).toBe(true)
    expect(me.organizations).toEqual([{ id: org.id, name: 'Acme Inc', slug: 'acme', role: 'owner' }])
  })

  it('checks slug availability', async () => {
    const user = await createUser()
    const check = async (slug: string) => (await call(`/api/organizations/slug-available?slug=${encodeURIComponent(slug)}`, { cookie: user.cookie })).json()

    expect(await check('acme')).toEqual({ available: true })
    expect(await check('ab')).toMatchObject({ available: false, reason: expect.stringMatching(/3 to 40/) })
    expect(await check('login')).toMatchObject({ available: false, reason: expect.stringMatching(/reserved/) })

    await createOrg(user, 'Acme', 'acme')
    expect(await check('acme')).toMatchObject({ available: false, reason: expect.stringMatching(/already uses/) })
    expect(await check('ACME')).toMatchObject({ available: false })
  })

  it('rejects a slug another organization uses', async () => {
    const first = await createUser()
    const second = await createUser()
    await createOrg(first, 'Acme', 'acme')
    const res = await call('/api/organizations', { cookie: second.cookie, json: { name: 'Other Acme', slug: 'acme' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ field: 'slug' })
    // Nothing half-created
    expect(await db.select().from(schema.organizations)).toHaveLength(1)
    expect(await db.select().from(schema.memberships)).toHaveLength(1)
  })

  it.each([
    [{ name: 'A', slug: 'acme' }, 'name'],
    [{ name: 'x'.repeat(61), slug: 'acme' }, 'name'],
    [{ slug: 'acme' }, 'name'],
    [{ name: 'Acme', slug: 'a' }, 'slug'],
    [{ name: 'Acme', slug: 'admin' }, 'slug'],
    [{ name: 'Acme', slug: 'acme_inc' }, 'slug'],
    [{ name: 'Acme' }, 'slug'],
  ])('validates %o', async (body, field) => {
    const user = await createUser()
    const res = await call('/api/organizations', { cookie: user.cookie, json: body })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field })
  })
})
