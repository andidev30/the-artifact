import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { sendSignInLink } from '../../src/mail.js'
import { call, createUser, sessionCookie } from './helpers.js'

const sendMock = vi.mocked(sendSignInLink)

async function requestLink(email: string, extra: Record<string, unknown> = {}) {
  const res = await call('/api/auth/email', { json: { email, ...extra } })
  expect(res.status).toBe(204)
  expect(sendMock).toHaveBeenCalledTimes(1)
  const [to, link, intent] = sendMock.mock.calls[0]
  return { to, link: new URL(link), intent }
}

function tokenOf(link: URL) {
  return link.searchParams.get('token')!
}

// What the confirmation page does when someone presses Continue
function confirm(link: URL, extra: Record<string, unknown> = {}) {
  return call('/api/auth/email/confirm', {
    json: {
      token: tokenOf(link),
      plan: link.searchParams.get('plan'),
      next: link.searchParams.get('next'),
      ...extra,
    },
  })
}

describe('magic link sign-in', () => {
  it('emails a link to the confirmation page, and continuing signs in and creates the account', async () => {
    const { to, link, intent } = await requestLink('  New.Person@Example.com ', { intent: 'signup' })
    expect(to).toBe('new.person@example.com')
    expect(intent).toBe('signup')
    expect(link.origin).toBe('http://localhost:5177')
    expect(link.pathname).toBe('/auth/confirm')

    const res = await confirm(link)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirect: 'http://localhost:5177/app' })
    const cookie = sessionCookie(res)
    expect(cookie).toBeTruthy()
    expect(res.headers.getSetCookie()[0]).toMatch(/HttpOnly/i)

    const me = await call('/api/me', { cookie: cookie! })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      email: 'new.person@example.com',
      onboarded: false,
      organizations: [],
      agentConnected: false,
      hasPublished: false,
    })
  })

  it('looking the link up has no side effects', async () => {
    const { link } = await requestLink('scanner@example.com')
    const path = `/api/auth/email/confirm?token=${encodeURIComponent(tokenOf(link))}`

    // A mail scanner (or the page itself) can look as often as it likes
    for (let i = 0; i < 3; i++) {
      const res = await call(path)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        email: 'scanner@example.com',
        expired: false,
        newAccount: true,
        setPassword: false,
        emailEnabled: true,
        setupCode: false,
      })
      expect(sessionCookie(res)).toBeNull()
    }
    expect(await db.select().from(schema.emailTokens)).toHaveLength(1)
    expect(await db.select().from(schema.users)).toHaveLength(0)
    expect(await db.select().from(schema.sessions)).toHaveLength(0)

    // The link still works afterwards
    expect(sessionCookie(await confirm(link))).toBeTruthy()
  })

  it('says whether continuing logs in to an existing account', async () => {
    await createUser({ email: 'old@example.com' })
    const { link } = await requestLink('old@example.com')
    const res = await call(`/api/auth/email/confirm?token=${encodeURIComponent(tokenOf(link))}`)
    expect(await res.json()).toMatchObject({ email: 'old@example.com', newAccount: false })
  })

  it('signs in to an existing account instead of creating another', async () => {
    const existing = await createUser({ email: 'known@example.com' })
    const { link } = await requestLink('KNOWN@example.com')
    const res = await confirm(link)
    const me = await (await call('/api/me', { cookie: sessionCookie(res)! })).json()
    expect(me.id).toBe(existing.id)
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('works only once', async () => {
    const { link } = await requestLink('once@example.com')
    expect(sessionCookie(await confirm(link))).toBeTruthy()

    const again = await confirm(link)
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ code: 'link_invalid' })
    expect(sessionCookie(again)).toBeNull()

    // The confirmation page now says it was used
    const lookup = await call(`/api/auth/email/confirm?token=${encodeURIComponent(tokenOf(link))}`)
    expect(lookup.status).toBe(404)
    expect(await lookup.json()).toMatchObject({ code: 'link_invalid' })
  })

  it('works once even when Continue is pressed twice at the same time', async () => {
    const { link } = await requestLink('race@example.com')
    const results = await Promise.all([confirm(link), confirm(link)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(await db.select().from(schema.sessions)).toHaveLength(1)
  })

  it('rejects an expired link', async () => {
    const { link } = await requestLink('late@example.com')
    await db
      .update(schema.emailTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.emailTokens.id, hashToken(tokenOf(link))))

    const lookup = await call(`/api/auth/email/confirm?token=${encodeURIComponent(tokenOf(link))}`)
    expect(lookup.status).toBe(200)
    expect(await lookup.json()).toEqual({
      email: 'late@example.com',
      expired: true,
      newAccount: true,
      setPassword: false,
      emailEnabled: true,
      setupCode: false,
    })

    const res = await confirm(link)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ code: 'link_expired', email: 'late@example.com' })
    expect(sessionCookie(res)).toBeNull()
    expect(await db.select().from(schema.users)).toHaveLength(0)
  })

  it('rejects missing and unknown tokens', async () => {
    for (const path of ['/api/auth/email/confirm', '/api/auth/email/confirm?token=nope']) {
      expect((await call(path)).status).toBe(404)
    }
    for (const json of [{}, { token: 'nope' }, { token: 42 }]) {
      const res = await call('/api/auth/email/confirm', { json })
      expect(res.status).toBe(400)
      expect(sessionCookie(res)).toBeNull()
    }
  })

  it('sends links from before the confirmation page to it, without using them', async () => {
    const { link } = await requestLink('legacy@example.com', { next: '/a/abc234', plan: 'organization' })
    const q = new URLSearchParams({ token: tokenOf(link), plan: 'organization', next: '/a/abc234' })
    const res = await call(`/api/auth/email/verify?${q}`)
    expect(res.status).toBe(302)
    expect(sessionCookie(res)).toBeNull()
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('http://localhost:5177/auth/confirm')
    expect(location.searchParams.get('token')).toBe(tokenOf(link))
    expect(location.searchParams.get('plan')).toBe('organization')
    expect(location.searchParams.get('next')).toBe('/a/abc234')
    expect(await db.select().from(schema.emailTokens)).toHaveLength(1)

    // An unsafe next is dropped on the way
    const evil = await call(`/api/auth/email/verify?token=${tokenOf(link)}&next=//evil.com`)
    expect(new URL(evil.headers.get('location')!).searchParams.has('next')).toBe(false)

    const missing = await call('/api/auth/email/verify')
    expect(missing.headers.get('location')).toBe('http://localhost:5177/login?error=link_invalid')
  })

  it('stores only a hash of the token', async () => {
    const { link } = await requestLink('hash@example.com')
    const token = tokenOf(link)
    const [row] = await db.select().from(schema.emailTokens)
    expect(row.id).toBe(hashToken(token))
    expect(row.id).not.toBe(token)
  })

  it('returns to a safe next path and keeps the plan', async () => {
    const { link } = await requestLink('next@example.com', { next: '/a/abc234', plan: 'organization' })
    expect(link.searchParams.get('next')).toBe('/a/abc234')
    const res = await confirm(link)
    expect((await res.json()).redirect).toBe('http://localhost:5177/a/abc234')

    sendMock.mockClear()
    const { link: orgLink } = await requestLink('plan@example.com', { plan: 'organization' })
    expect((await (await confirm(orgLink)).json()).redirect).toBe('http://localhost:5177/app?plan=organization')
  })

  it('drops an unsafe next path', async () => {
    const { link } = await requestLink('evil@example.com', { next: '//evil.com' })
    expect(link.searchParams.has('next')).toBe(false)
    // Even a next sent by hand is ignored
    expect((await (await confirm(link, { next: '//evil.com' })).json()).redirect).toBe('http://localhost:5177/app')
  })

  it('drops next paths that a browser would read as another site', async () => {
    const tricky = ['/\t/evil.example', '/\n/evil.example', '/\t\\evil.example', '/\\evil.example', '/%2F/evil.example', '/..//evil.example']
    for (const [i, next] of tricky.entries()) {
      sendMock.mockClear()
      const { link } = await requestLink(`tricky${i}@example.com`, { next })
      expect(link.searchParams.has('next')).toBe(false)
      expect((await (await confirm(link, { next })).json()).redirect).toBe('http://localhost:5177/app')
    }
  })

  it('rejects invalid email addresses', async () => {
    for (const email of ['', 'nope', 'a@b', 'a b@c.com']) {
      const res = await call('/api/auth/email', { json: { email } })
      expect(res.status).toBe(400)
    }
    expect((await call('/api/auth/email', { json: undefined, method: 'POST' })).status).toBe(400)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not send a second link within a minute', async () => {
    await requestLink('twice@example.com')
    const res = await call('/api/auth/email', { json: { email: 'twice@example.com' } })
    expect(res.status).toBe(204)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(await db.select().from(schema.emailTokens)).toHaveLength(1)
  })

  it('reports when the email cannot be sent', async () => {
    sendMock.mockRejectedValueOnce(new Error('SMTP down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/api/auth/email', { json: { email: 'down@example.com' } })
    expect(res.status).toBe(502)
    spy.mockRestore()
  })
})

describe('sessions', () => {
  it('/api/me needs a session', async () => {
    expect((await call('/api/me')).status).toBe(401)
    expect((await call('/api/me', { cookie: 'session=garbage' })).status).toBe(401)
  })

  it('/api/me describes the signed-in person', async () => {
    const user = await createUser({ email: 'me@example.com', name: 'Me Myself' })
    const res = await call('/api/me', { cookie: user.cookie })
    expect(await res.json()).toEqual({
      id: user.id,
      email: 'me@example.com',
      name: 'Me Myself',
      avatarUrl: null,
      hasPassword: false,
      onboarded: true,
      organizations: [],
      twoFactor: false,
      agentConnected: false,
      hasPublished: false,
      isAdmin: false,
      autoJoined: [],
    })
  })

  it('logout ends the session', async () => {
    const user = await createUser()
    const res = await call('/api/auth/logout', { method: 'POST', cookie: user.cookie })
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie().join()).toMatch(/session=;/)
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
    expect(await db.select().from(schema.sessions)).toHaveLength(0)
  })

  it('logout without a session is harmless', async () => {
    expect((await call('/api/auth/logout', { method: 'POST' })).status).toBe(204)
  })

  it('expired sessions stop working and are removed', async () => {
    const user = await createUser()
    await db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) })
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
    expect(await db.select().from(schema.sessions)).toHaveLength(0)
  })

  it('renews a session with less than half its lifetime left', async () => {
    const user = await createUser()
    const soon = new Date(Date.now() + 2 * 86_400_000)
    await db.update(schema.sessions).set({ expiresAt: soon })
    const res = await call('/api/me', { cookie: user.cookie })
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBe(user.cookie)
    const [session] = await db.select().from(schema.sessions)
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
  })
})
