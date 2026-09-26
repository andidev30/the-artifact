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

// The emailed link points at the web app, which proxies /api to this app
function verifyPath(link: URL) {
  return link.pathname + link.search
}

describe('magic link sign-in', () => {
  it('emails a link that signs in and creates the account', async () => {
    const { to, link, intent } = await requestLink('  New.Person@Example.com ', { intent: 'signup' })
    expect(to).toBe('new.person@example.com')
    expect(intent).toBe('signup')
    expect(link.origin).toBe('http://localhost:5177')
    expect(link.pathname).toBe('/api/auth/email/verify')

    const res = await call(verifyPath(link))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:5177/app')
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

  it('signs in to an existing account instead of creating another', async () => {
    const existing = await createUser({ email: 'known@example.com' })
    const { link } = await requestLink('KNOWN@example.com')
    const res = await call(verifyPath(link))
    const me = await (await call('/api/me', { cookie: sessionCookie(res)! })).json()
    expect(me.id).toBe(existing.id)
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('works only once', async () => {
    const { link } = await requestLink('once@example.com')
    expect(sessionCookie(await call(verifyPath(link)))).toBeTruthy()

    const again = await call(verifyPath(link))
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toBe('http://localhost:5177/login?error=link_invalid')
    expect(sessionCookie(again)).toBeNull()
  })

  it('rejects an expired link', async () => {
    const { link } = await requestLink('late@example.com')
    const token = link.searchParams.get('token')!
    await db.update(schema.emailTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.emailTokens.id, hashToken(token)))

    const res = await call(verifyPath(link))
    expect(res.headers.get('location')).toBe('http://localhost:5177/login?error=link_expired')
    expect(sessionCookie(res)).toBeNull()
    expect(await db.select().from(schema.users)).toHaveLength(0)
  })

  it('rejects missing and unknown tokens', async () => {
    for (const path of ['/api/auth/email/verify', '/api/auth/email/verify?token=nope']) {
      const res = await call(path)
      expect(res.headers.get('location')).toBe('http://localhost:5177/login?error=link_invalid')
    }
  })

  it('stores only a hash of the token', async () => {
    const { link } = await requestLink('hash@example.com')
    const token = link.searchParams.get('token')!
    const [row] = await db.select().from(schema.emailTokens)
    expect(row.id).toBe(hashToken(token))
    expect(row.id).not.toBe(token)
  })

  it('returns to a safe next path and keeps the plan', async () => {
    const { link } = await requestLink('next@example.com', { next: '/a/abc234', plan: 'organization' })
    expect(link.searchParams.get('next')).toBe('/a/abc234')
    const res = await call(verifyPath(link))
    expect(res.headers.get('location')).toBe('http://localhost:5177/a/abc234')

    sendMock.mockClear()
    const { link: orgLink } = await requestLink('plan@example.com', { plan: 'organization' })
    expect((await call(verifyPath(orgLink))).headers.get('location')).toBe('http://localhost:5177/app?plan=organization')
  })

  it('drops an unsafe next path', async () => {
    const { link } = await requestLink('evil@example.com', { next: '//evil.com' })
    expect(link.searchParams.has('next')).toBe(false)
    // Even a next added to the link by hand is ignored
    link.searchParams.set('next', '//evil.com')
    expect((await call(verifyPath(link))).headers.get('location')).toBe('http://localhost:5177/app')
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
      onboarded: true,
      organizations: [],
      agentConnected: false,
      hasPublished: false,
      isAdmin: false,
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
