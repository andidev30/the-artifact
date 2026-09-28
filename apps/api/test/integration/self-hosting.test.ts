import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { findOrCreateUser } from '../../src/auth/users.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
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
    const first = await findOrCreateUser({ email: 'first@example.com', method: 'email_link' })
    const second = await findOrCreateUser({ email: 'second@example.com', method: 'email_link' })
    expect(first.isAdmin).toBe(true)
    expect(await onboarded('first@example.com')).toBe(false)
    expect(second.isAdmin).toBe(false)
    expect(await onboarded('second@example.com')).toBe(true)
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
