import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { call, createOrg, createPage, createUser } from './helpers.js'

const sendMock = vi.mocked(sendSignInLink)

describe('config for the web app', () => {
  it('tells the web app about this install', async () => {
    const res = await call('/api/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ selfHosted: false, googleSignIn: false })
  })
})

describe('ALLOWED_EMAIL_DOMAINS', () => {
  afterEach(() => {
    env.allowedEmailDomains.length = 0
  })

  const request = (email: string) => call('/api/auth/email', { json: { email, intent: 'signup' } })

  it('lets anyone sign up when it is empty', async () => {
    expect((await request('anyone@elsewhere.com')).status).toBe(204)
  })

  it('refuses new accounts from other domains, without sending a link', async () => {
    env.allowedEmailDomains.push('example.com')
    const res = await request('outsider@elsewhere.com')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'signup_closed' })
    expect(sendMock).not.toHaveBeenCalled()
    expect((await request('insider@example.com')).status).toBe(204)
  })

  it('still lets existing accounts sign in', async () => {
    await createUser({ email: 'old@elsewhere.com' })
    env.allowedEmailDomains.push('example.com')
    expect((await request('old@elsewhere.com')).status).toBe(204)
  })

  it('accepts people invited to an organization or a page', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const org = await createOrg(owner)
    await db.insert(schema.invitations).values({
      organizationId: org.id,
      email: 'guest@elsewhere.com',
      role: 'member',
      tokenHash: hashToken('invite-token'),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const page = await createPage(owner)
    await db.insert(schema.artifactShares).values({ artifactId: page.id, email: 'reader@elsewhere.com', role: 'viewer' })
    env.allowedEmailDomains.push('example.com')

    expect((await request('guest@elsewhere.com')).status).toBe(204)
    expect((await request('reader@elsewhere.com')).status).toBe(204)
  })

  it('refuses a sign-in link opened after the domain was closed', async () => {
    expect((await request('late@elsewhere.com')).status).toBe(204)
    const link = new URL(sendMock.mock.calls[0][1])
    env.allowedEmailDomains.push('example.com')
    const res = await call('/api/auth/email/confirm', { json: { token: link.searchParams.get('token') } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'signup_closed' })
  })
})
