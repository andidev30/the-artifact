import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findOrCreateUser } from '../../src/auth/users.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendSignInLink } from '../../src/mail.js'
import { storeSetupCode } from '../../src/setup-code.js'
import { call } from './helpers.js'

describe('config for the web app', () => {
  it('tells the web app about this install', async () => {
    const res = await call('/api/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      selfHosted: false,
      googleSignIn: false,
      emailSignIn: true,
      needsSetup: false,
      setupCode: false,
      passwordSignUp: false,
      instanceName: null,
      newOrganizations: false,
      sso: [],
    })
  })
})

describe('new accounts on a self-hosted install', () => {
  const original = env.selfHosted
  afterEach(() => {
    env.selfHosted = original
  })

  async function onboarded(email: string) {
    const [row] = await db.select({ onboardedAt: schema.users.onboardedAt }).from(schema.users).where(eq(schema.users.email, email))
    return row.onboardedAt !== null
  }

  it('lets the first account set the server up, and starts everyone after it in a personal workspace', async () => {
    env.selfHosted = true
    await storeSetupCode('ABCD-EFGH-JKMN')
    const first = await findOrCreateUser({ email: 'first@example.com', method: 'email_link', setupCode: 'ABCD-EFGH-JKMN' })
    const second = await findOrCreateUser({ email: 'second@example.com', method: 'email_link' })
    expect(first.isAdmin).toBe(true)
    expect(await onboarded('first@example.com')).toBe(false)
    expect(second.isAdmin).toBe(false)
    expect(await onboarded('second@example.com')).toBe(true)
  })

  it('asks for the setup code when the first account uses its email link, without using the link up', async () => {
    env.selfHosted = true
    await storeSetupCode('ABCD-EFGH-JKMN')
    expect(await (await call('/api/config')).json()).toMatchObject({ emailSignIn: true, needsSetup: false, setupCode: true })
    expect((await call('/api/auth/email', { json: { email: 'owner@example.com', intent: 'signup' } })).status).toBe(204)
    const token = new URL(vi.mocked(sendSignInLink).mock.calls.at(-1)![1]).searchParams.get('token')
    expect(await (await call(`/api/auth/email/confirm?token=${token}`)).json()).toMatchObject({ newAccount: true, setupCode: true })

    for (const setupCode of [undefined, 'ABCD-EFGH-JKMP']) {
      const res = await call('/api/auth/email/confirm', { json: { token, setupCode } })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'setupCode' })
    }
    const res = await call('/api/auth/email/confirm', { json: { token, setupCode: 'abcd-efgh-jkmn' } })
    expect(res.status).toBe(200)
    const [owner] = await db.select().from(schema.users)
    expect(owner).toMatchObject({ email: 'owner@example.com', isAdmin: true })
    expect(await (await call('/api/config')).json()).toMatchObject({ setupCode: false })
  })

  it('turns away Google and single sign-on for the first account', async () => {
    env.selfHosted = true
    await storeSetupCode('ABCD-EFGH-JKMN')
    await expect(findOrCreateUser({ email: 'first@example.com', googleSub: '123', method: 'google' })).rejects.toMatchObject({ code: 'needs_setup' })
    expect(await db.select().from(schema.users)).toHaveLength(0)
  })

  it('lets everyone choose a workspace on the hosted service', async () => {
    env.selfHosted = false
    await findOrCreateUser({ email: 'first@example.com', method: 'email_link' })
    await findOrCreateUser({ email: 'second@example.com', method: 'email_link' })
    expect(await onboarded('first@example.com')).toBe(false)
    expect(await onboarded('second@example.com')).toBe(false)
  })

  it('has no contact sales form', async () => {
    env.selfHosted = true
    const res = await call('/api/contact-sales', { json: { name: 'Dana', email: 'dana@acme.example' } })
    expect(res.status).toBe(404)
  })
})
