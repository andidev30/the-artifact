import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendCommentNotice, sendInvitation, sendShareNotice } from '../../src/mail.js'
import { call, createOrg, createPage, createUser, sessionCookie, type TestUser } from './helpers.js'

// A server without SMTP_HOST: passwords instead of emailed links, and links admins pass on by hand
const original = { host: env.smtp.host, selfHosted: env.selfHosted }

beforeEach(() => {
  env.smtp.host = ''
  env.selfHosted = true
})

afterEach(() => {
  env.smtp.host = original.host
  env.selfHosted = original.selfHosted
})

const config = async () => (await call('/api/config')).json()
const login = (email: string, password: string) => call('/api/auth/password/login', { json: { email, password } })

async function withPassword(user: TestUser, password: string) {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(schema.users.id, user.id))
}

describe('first run', () => {
  it('asks for setup until the first account exists, which becomes the admin', async () => {
    expect(await config()).toMatchObject({ emailSignIn: false, needsSetup: true })

    const res = await call('/api/auth/password/setup', { json: { email: 'Owner@Example.com', password: 'correct horse', name: ' Ada ' } })
    expect(res.status).toBe(201)
    const cookie = sessionCookie(res)!
    const me = await (await call('/api/me', { cookie })).json()
    expect(me).toMatchObject({ email: 'owner@example.com', name: 'Ada', isAdmin: true, hasPassword: true })
    expect(await config()).toMatchObject({ needsSetup: false })
  })

  it('works only once, even when two people race for it', async () => {
    const results = await Promise.all(
      ['a@example.com', 'b@example.com'].map((email) => call('/api/auth/password/setup', { json: { email, password: 'long enough' } })),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await db.select().from(schema.users)).toHaveLength(1)
  })

  it('rejects short passwords', async () => {
    const res = await call('/api/auth/password/setup', { json: { email: 'a@example.com', password: 'short' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field: 'password' })
  })

  it('is closed on a server that sends email', async () => {
    env.smtp.host = 'localhost'
    expect(await config()).toMatchObject({ emailSignIn: true, needsSetup: false })
    expect((await call('/api/auth/password/setup', { json: { email: 'a@example.com', password: 'long enough' } })).status).toBe(409)
  })
})

describe('password login', () => {
  it('signs in with the right password only', async () => {
    const user = await createUser({ email: 'pat@example.com' })
    await withPassword(user, 'right password')
    expect((await login('pat@example.com', 'wrong password')).status).toBe(401)
    const res = await login('PAT@example.com', 'right password')
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBeTruthy()
  })

  it('answers the same for unknown addresses', async () => {
    const res = await login('nobody@example.com', 'whatever123')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'wrong_password' })
  })

  it('slows down guessing', async () => {
    const user = await createUser({ email: 'guess@example.com' })
    await withPassword(user, 'right password')
    for (let i = 0; i < 10; i++) await login('guess@example.com', `wrong ${i}`)
    const res = await login('guess@example.com', 'right password')
    expect(res.status).toBe(429)
  })

  it('refuses suspended accounts', async () => {
    const user = await createUser({ email: 'gone@example.com' })
    await withPassword(user, 'right password')
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, user.id))
    expect((await login('gone@example.com', 'right password')).status).toBe(403)
  })

  it('refuses to email sign-in links', async () => {
    const res = await call('/api/auth/email', { json: { email: 'a@example.com', intent: 'login' } })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'email_disabled' })
  })
})

describe('signing up with a password', () => {
  const signUp = (email: string, password = 'long enough') => call('/api/auth/password/sign-up', { json: { email, password, name: 'Sam' } })
  const policy = (signupPolicy: 'open' | 'domains' | 'invite-only', allowedDomains: string[] = []) =>
    db
      .insert(schema.instanceSettings)
      .values({ signupPolicy, allowedDomains })
      .onConflictDoUpdate({ target: schema.instanceSettings.id, set: { signupPolicy, allowedDomains } })

  beforeEach(async () => {
    await createUser({ admin: true })
  })

  it('is open while anyone may sign up, and signs the person in', async () => {
    expect(await config()).toMatchObject({ passwordSignUp: true })
    const res = await signUp('Sam@Example.com')
    expect(res.status).toBe(201)
    expect(await (await call('/api/me', { cookie: sessionCookie(res)! })).json()).toMatchObject({ email: 'sam@example.com', name: 'Sam', isAdmin: false })
    expect((await login('sam@example.com', 'long enough')).status).toBe(200)
  })

  it('follows the email domains policy', async () => {
    await policy('domains', ['corp.test'])
    expect((await signUp('a@elsewhere.com')).status).toBe(403)
    expect((await signUp('a@corp.test')).status).toBe(201)
  })

  it('is closed when only invited people may sign up', async () => {
    await policy('invite-only')
    expect(await config()).toMatchObject({ passwordSignUp: false })
    expect((await signUp('a@example.com')).status).toBe(403)
  })

  it('won’t let anyone claim an address someone invited or shared a page with', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'invited@example.com', role: 'member' } })
    const page = await createPage(owner)
    await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: 'reader@example.com', role: 'viewer' } })

    for (const email of ['invited@example.com', 'reader@example.com']) {
      const res = await signUp(email)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'use_invitation' })
    }
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'reader@example.com'))).toHaveLength(0)
  })

  it('never touches an existing account', async () => {
    const existing = await createUser({ email: 'taken@example.com' })
    await withPassword(existing, 'their password')
    expect((await signUp('taken@example.com', 'someone else')).status).toBe(409)
    expect((await login('taken@example.com', 'their password')).status).toBe(200)
  })

  it('is closed on a server that sends email', async () => {
    env.smtp.host = 'localhost'
    expect((await signUp('a@example.com')).status).toBe(409)
  })
})

describe('sign-up links made by an admin', () => {
  let admin: TestUser
  beforeEach(async () => {
    admin = await createUser({ admin: true })
    // Invite-only, to show admin links work whatever the policy
    await db.insert(schema.instanceSettings).values({ signupPolicy: 'invite-only', allowedDomains: [] })
  })

  const makeLink = async (email: string) => {
    const res = await call('/api/admin/sign-up-links', { cookie: admin.cookie, json: { email } })
    expect(res.status).toBe(201)
    return (await res.json()) as { link: string; newAccount: boolean }
  }
  const tokenOf = (link: string) => new URL(link).searchParams.get('token')!

  it('creates the account with the password the person chooses', async () => {
    const made = await makeLink('new@elsewhere.com')
    expect(made.newAccount).toBe(true)
    const token = tokenOf(made.link)

    expect(await (await call(`/api/auth/email/confirm?token=${token}`)).json()).toMatchObject({ newAccount: true, setPassword: true, emailEnabled: false })
    // A bad password doesn't use the link up
    expect((await call('/api/auth/email/confirm', { json: { token, password: 'short' } })).status).toBe(400)
    const res = await call('/api/auth/email/confirm', { json: { token, password: 'a good password' } })
    expect(res.status).toBe(200)

    expect((await login('new@elsewhere.com', 'a good password')).status).toBe(200)
    // Links work once
    expect((await call('/api/auth/email/confirm', { json: { token, password: 'a good password' } })).status).toBe(400)
  })

  it('resets the password of an existing account and signs it out elsewhere', async () => {
    const user = await createUser({ email: 'forgot@example.com' })
    await withPassword(user, 'old password')
    const made = await makeLink('forgot@example.com')
    expect(made.newAccount).toBe(false)
    await call('/api/auth/email/confirm', { json: { token: tokenOf(made.link), password: 'new password' } })

    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(401)
    expect((await login('forgot@example.com', 'old password')).status).toBe(401)
    expect((await login('forgot@example.com', 'new password')).status).toBe(200)
  })

  it('is only for admins, and only on servers without email', async () => {
    const someone = await createUser()
    expect((await call('/api/admin/sign-up-links', { cookie: someone.cookie, json: { email: 'x@example.com' } })).status).toBe(403)
    env.smtp.host = 'localhost'
    expect((await call('/api/admin/sign-up-links', { cookie: admin.cookie, json: { email: 'x@example.com' } })).status).toBe(409)
  })
})

describe('organization invitations', () => {
  it('returns the link to pass on and lets someone new sign up from it', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const res = await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'joiner@example.com', role: 'member' } })
    const body = await res.json()
    expect(body).toMatchObject({ emailed: false })
    expect(sendInvitation).not.toHaveBeenCalled()
    const token = new URL(body.link).pathname.split('/').pop()!

    expect(await (await call(`/api/invitations/${token}`)).json()).toMatchObject({ canSignUpHere: true })
    const joined = await call(`/api/invitations/${token}/sign-up`, { json: { password: 'joiner password', name: 'Jo' } })
    expect(joined.status).toBe(201)
    expect(await joined.json()).toMatchObject({ id: org.id, role: 'member' })
    const me = await (await call('/api/me', { cookie: sessionCookie(joined)! })).json()
    expect(me).toMatchObject({ email: 'joiner@example.com', name: 'Jo', isAdmin: false, organizations: [{ id: org.id }] })
  })

  it('never touches an account that already exists', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const existing = await createUser({ email: 'taken@example.com' })
    await withPassword(existing, 'their password')
    const body = await (
      await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'taken@example.com', role: 'member' } })
    ).json()
    const token = new URL(body.link).pathname.split('/').pop()!

    const res = await call(`/api/invitations/${token}/sign-up`, { json: { password: 'attacker password' } })
    expect(res.status).toBe(409)
    expect((await login('taken@example.com', 'their password')).status).toBe(200)
  })

  it('an account that signed up on its own joins only with the invitation link', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const signUp = await call('/api/auth/password/sign-up', { json: { email: 'later@example.com', password: 'their password' } })
    expect(signUp.status).toBe(201)
    const cookie = sessionCookie(signUp)!
    const body = await (
      await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'later@example.com', role: 'admin' } })
    ).json()
    const [invitation] = await db.select().from(schema.invitations)

    expect(await (await call('/api/me/invitations', { cookie })).json()).toEqual([])
    expect((await call(`/api/me/invitations/${invitation.id}/accept`, { cookie, method: 'POST' })).status).toBe(404)
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.organizationId, org.id))).toHaveLength(1)

    const token = new URL(body.link).pathname.split('/').pop()!
    const joined = await call(`/api/invitations/${token}/accept`, { cookie, method: 'POST' })
    expect(joined.status).toBe(200)
    expect(await joined.json()).toMatchObject({ id: org.id, role: 'admin' })
  })

  it('lists invitations in the app for accounts whose address was checked', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const member = await createUser({ email: 'checked@example.com' })
    await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: 'checked@example.com', role: 'member' } })
    const [listed] = await (await call('/api/me/invitations', { cookie: member.cookie })).json()
    expect((await call(`/api/me/invitations/${listed.id}/accept`, { cookie: member.cookie, method: 'POST' })).status).toBe(200)
  })
})

describe('sharing and settings', () => {
  it('shares without trying to email', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const res = await call(`/api/artifacts/${page.slug}/sharing/people`, {
      cookie: owner.cookie,
      json: { emails: 'reader@example.com', role: 'viewer', notify: true },
    })
    expect(res.status).toBe(200)
    expect(sendShareNotice).not.toHaveBeenCalled()
  })

  it('takes comments without emailing anyone; new ones show as unread instead', async () => {
    const owner = await createUser()
    const reader = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const res = await call(`/api/artifacts/${page.slug}/comments`, { cookie: reader.cookie, json: { body: 'Nice page' } })
    expect(res.status).toBe(201)
    expect(sendCommentNotice).not.toHaveBeenCalled()
    const details = await (await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie })).json()
    expect(details.comments).toEqual({ total: 1, unread: 1 })
  })

  it('changes the password, checking the current one', async () => {
    const user = await createUser({ email: 'me@example.com' })
    await withPassword(user, 'first password')
    const wrong = await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { currentPassword: 'nope', password: 'second password' } })
    expect(wrong.status).toBe(400)
    const ok = await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { currentPassword: 'first password', password: 'second password' } })
    expect(ok.status).toBe(204)
    expect(sessionCookie(ok)).toBeTruthy()
    expect((await login('me@example.com', 'second password')).status).toBe(200)
  })

  it('lets someone without a password set one', async () => {
    const user = await createUser({ email: 'google@example.com' })
    const res = await call('/api/me/password', { method: 'PUT', cookie: user.cookie, json: { password: 'brand new one' } })
    expect(res.status).toBe(204)
    expect((await login('google@example.com', 'brand new one')).status).toBe(200)
  })
})
