import { describe, expect, it, vi } from 'vitest'
import { sendShareNotice } from '../../src/mail.js'
import { call, createPage, createUser, type TestUser } from './helpers.js'

const notice = vi.mocked(sendShareNotice)

async function setup() {
  const owner = await createUser({ email: 'owner@example.com', name: 'Olivia Owner' })
  const page = await createPage(owner, { title: 'Quarterly report' })
  return { owner, page, base: `/api/artifacts/${page.slug}/sharing` }
}

function share(base: string, user: TestUser, body: Record<string, unknown>) {
  return call(`${base}/people`, { cookie: user.cookie, json: body })
}

describe('sharing endpoints', () => {
  it('starts with just the owner', async () => {
    const { owner, page, base } = await setup()
    const res = await call(base, { cookie: owner.cookie })
    expect(await res.json()).toEqual({
      owner: { name: 'Olivia Owner', email: 'owner@example.com', avatarUrl: null },
      people: [],
      visibility: 'private',
      link: {
        expiresAt: null,
        password: false,
        expired: false,
        url: `http://localhost:5177/a/${page.slug}`,
        embedUrl: `http://localhost:5177/e/${page.slug}`,
      },
      organizationName: null,
    })
  })

  it('adds people and emails them', async () => {
    const { owner, page, base } = await setup()
    await createUser({ email: 'known@example.com', name: 'Known Person' })

    const res = await share(base, owner, { emails: 'Known@example.com, new@example.com', role: 'editor', message: 'Please review' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.shared).toEqual(['known@example.com', 'new@example.com'])
    expect(body.notifyFailed).toEqual([])
    expect(body.sharing.people).toEqual([
      { email: 'known@example.com', role: 'editor', name: 'Known Person', avatarUrl: null, pending: false },
      { email: 'new@example.com', role: 'editor', name: null, avatarUrl: null, pending: true },
    ])

    expect(notice).toHaveBeenCalledTimes(2)
    expect(notice).toHaveBeenCalledWith('new@example.com', {
      from: 'Olivia Owner',
      title: 'Quarterly report',
      link: `http://localhost:5177/a/${page.slug}`,
      role: 'editor',
      message: 'Please review',
    })
  })

  it('defaults to viewer and can skip the email', async () => {
    const { owner, base } = await setup()
    const res = await share(base, owner, { emails: ['a@example.com'], role: 'superuser', notify: false })
    expect((await res.json()).sharing.people[0].role).toBe('viewer')
    expect(notice).not.toHaveBeenCalled()
  })

  it('sharing again with the same person updates their role', async () => {
    const { owner, base } = await setup()
    await share(base, owner, { emails: ['a@example.com'], role: 'viewer', notify: false })
    const body = await (await share(base, owner, { emails: ['A@example.com'], role: 'editor', notify: false })).json()
    expect(body.sharing.people).toHaveLength(1)
    expect(body.sharing.people[0].role).toBe('editor')
  })

  it('changes a role', async () => {
    const { owner, base } = await setup()
    await share(base, owner, { emails: ['a@example.com'], notify: false })
    const res = await call(`${base}/people`, { method: 'PATCH', cookie: owner.cookie, json: { email: 'A@Example.com', role: 'editor' } })
    expect(res.status).toBe(200)
    expect((await res.json()).people[0]).toMatchObject({ email: 'a@example.com', role: 'editor' })

    const missing = await call(`${base}/people`, { method: 'PATCH', cookie: owner.cookie, json: { email: 'nobody@example.com', role: 'editor' } })
    expect(missing.status).toBe(400)
    const badRole = await call(`${base}/people`, { method: 'PATCH', cookie: owner.cookie, json: { email: 'a@example.com', role: 'owner' } })
    expect(badRole.status).toBe(400)
  })

  it('removes a person, who then loses access', async () => {
    const { owner, page, base } = await setup()
    const friend = await createUser({ email: 'friend@example.com' })
    await share(base, owner, { emails: ['friend@example.com'], notify: false })
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: friend.cookie })).status).toBe(200)

    const res = await call(`${base}/people?email=${encodeURIComponent('Friend@example.com')}`, { method: 'DELETE', cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect((await res.json()).people).toEqual([])
    expect((await call(`/api/artifacts/${page.slug}`, { cookie: friend.cookie })).status).toBe(404)

    expect((await call(`${base}/people`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(400)
  })

  it('rejects invalid email addresses and shares with nobody', async () => {
    const { owner, base } = await setup()
    const res = await share(base, owner, { emails: 'ok@example.com, not-an-email' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not-an-email/)
    expect((await (await call(base, { cookie: owner.cookie })).json()).people).toEqual([])

    expect((await share(base, owner, { emails: '' })).status).toBe(400)
    expect((await share(base, owner, {})).status).toBe(400)
  })

  it('limits one invite to 20 people', async () => {
    const { owner, base } = await setup()
    const emails = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`)
    const res = await share(base, owner, { emails, notify: false })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/up to 20/)
  })

  it('the owner cannot share with themselves', async () => {
    const { owner, base } = await setup()
    const res = await share(base, owner, { emails: 'OWNER@example.com' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/owner already has access/)

    // Mixed with others, the owner is just skipped
    const mixed = await (await share(base, owner, { emails: 'owner@example.com, b@example.com', notify: false })).json()
    expect(mixed.shared).toEqual(['b@example.com'])
  })

  it('viewers and strangers cannot manage sharing; editors can', async () => {
    const { owner, base } = await setup()
    const viewer = await createUser({ email: 'viewer@example.com' })
    const editor = await createUser({ email: 'editor@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    await share(base, owner, { emails: 'viewer@example.com', role: 'viewer', notify: false })
    await share(base, owner, { emails: 'editor@example.com', role: 'editor', notify: false })

    for (const user of [viewer, stranger]) {
      expect((await call(base, { cookie: user.cookie })).status).toBe(404)
      expect((await share(base, user, { emails: 'x@example.com' })).status).toBe(404)
      expect((await call(`${base}/people`, { method: 'PATCH', cookie: user.cookie, json: { email: 'viewer@example.com', role: 'editor' } })).status).toBe(404)
      expect((await call(`${base}/people?email=editor@example.com`, { method: 'DELETE', cookie: user.cookie })).status).toBe(404)
    }
    expect((await call(base)).status).toBe(401)

    const res = await share(base, editor, { emails: 'x@example.com', notify: true })
    expect(res.status).toBe(200)
    expect(notice).toHaveBeenLastCalledWith('x@example.com', expect.objectContaining({ from: 'editor@example.com' }))
  })

  it('reports addresses the email could not reach, but keeps the share', async () => {
    const { owner, base } = await setup()
    notice.mockImplementation(async (to) => {
      if (to === 'bad@example.com') throw new Error('mailbox unavailable')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = await (await share(base, owner, { emails: 'good@example.com, bad@example.com' })).json()
    spy.mockRestore()
    notice.mockReset()
    expect(body.shared).toEqual(['good@example.com', 'bad@example.com'])
    expect(body.notifyFailed).toEqual(['bad@example.com'])
    expect(body.sharing.people).toHaveLength(2)
  })
})
