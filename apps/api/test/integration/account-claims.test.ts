import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { findOrCreateUser } from '../../src/auth/users.js'
import { db, schema } from '../../src/db/index.js'
import { sendSignInLink } from '../../src/mail.js'
import { call, callTool, connectAgent, createOrg, createPage, createUser, mcpRequest, sessionCookie, type TestUser } from './helpers.js'

// Accounts whose address nobody checked (users.email_unverified): made by signing up with a password on
// a server without email, or from an invitation link passed on by hand
async function unverified(email: string, password = 'their password'): Promise<TestUser> {
  const user = await createUser({ email })
  await db
    .update(schema.users)
    .set({ emailUnverified: true, passwordHash: await hashPassword(password) })
    .where(eq(schema.users.id, user.id))
  return user
}

type Shared = { shared: string[]; notifyFailed: string[]; links: { email: string; link: string }[] }

async function share(owner: TestUser, slug: string, emails: string[], opts: { role?: 'viewer' | 'editor'; notify?: boolean } = {}) {
  const res = await call(`/api/artifacts/${slug}/sharing/people`, { cookie: owner.cookie, json: { emails, role: opts.role ?? 'viewer', notify: opts.notify } })
  expect(res.status).toBe(200)
  return (await res.json()) as Shared & { sharing: { people: { email: string; name: string | null; pending: boolean }[] } }
}

const tokenOf = (link: string) => new URL(link).searchParams.get('share')!
const accept = (user: TestUser, slug: string, token: string) => call(`/api/artifacts/${slug}/sharing/accept`, { cookie: user.cookie, json: { token } })
const opens = async (user: TestUser, slug: string) => (await call(`/api/artifacts/${slug}`, { cookie: user.cookie })).status
const sharedList = async (user: TestUser) => (await (await call('/api/artifacts?workspace=shared', { cookie: user.cookie })).json()) as { slug: string }[]

describe('shares and unverified addresses', () => {
  it('don’t count for an account whose address nobody checked, until it opens the share’s link', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const squatter = await unverified('cfo@corp.test')
    squatter.name = 'Chief Financial Officer'
    await db.update(schema.users).set({ name: squatter.name }).where(eq(schema.users.id, squatter.id))

    const { links, sharing } = await share(owner, page.slug, ['cfo@corp.test'], { role: 'editor', notify: false })
    // The sharer sees the person as not signed in yet, without the name whoever typed the address chose
    expect(sharing.people).toEqual([expect.objectContaining({ email: 'cfo@corp.test', name: null, pending: true })])
    expect(await opens(squatter, page.slug)).toBe(404)
    expect(await sharedList(squatter)).toEqual([])
    expect((await call(`/api/artifacts/${page.slug}/sharing`, { cookie: squatter.cookie })).status).toBe(404)
    const token = (await connectAgent(squatter)).access_token
    expect((await callTool(token, 'get_artifact', { artifact_id: page.slug })).isError).toBe(true)

    // Whoever the sharer gave the link to proves it by opening it signed in with the address
    const [{ link }] = links
    expect(link).toBe(`http://localhost:5177/a/${page.slug}?share=${tokenOf(link)}`)
    expect((await accept(squatter, page.slug, tokenOf(link))).status).toBe(204)
    expect(await opens(squatter, page.slug)).toBe(200)
    expect((await sharedList(squatter)).map((p) => p.slug)).toEqual([page.slug])
    const after = await (await call(`/api/artifacts/${page.slug}/sharing`, { cookie: owner.cookie })).json()
    expect(after.people).toEqual([expect.objectContaining({ name: 'Chief Financial Officer', pending: false })])
    // Links work once
    expect((await accept(squatter, page.slug, tokenOf(link))).status).toBe(404)
  })

  it('count at once for an account whose address was checked', async () => {
    const owner = await createUser()
    const reader = await createUser({ email: 'reader@corp.test', name: 'Rae' })
    const page = await createPage(owner)
    const { sharing } = await share(owner, page.slug, ['reader@corp.test'])
    expect(sharing.people).toEqual([expect.objectContaining({ name: 'Rae', pending: false })])
    expect(await opens(reader, page.slug)).toBe(200)
  })

  it('a share’s link does nothing for another address, signed out, or on another page', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const other = await createPage(owner)
    const { links } = await share(owner, page.slug, ['meant@corp.test'], { notify: false })
    const token = tokenOf(links[0].link)
    const someone = await unverified('someone@corp.test')
    expect((await accept(someone, page.slug, token)).status).toBe(404)
    expect(await opens(someone, page.slug)).toBe(404)
    expect((await call(`/api/artifacts/${page.slug}/sharing/accept`, { json: { token } })).status).toBe(401)
    const meant = await unverified('meant@corp.test')
    expect((await accept(meant, other.slug, token)).status).toBe(404)
    expect((await accept(meant, page.slug, 'not-the-token')).status).toBe(404)
    expect((await accept(meant, page.slug, token)).status).toBe(204)
  })

  it('sharing with the address again makes a new link and the earlier one stops working', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const first = await share(owner, page.slug, ['again@corp.test'], { notify: false })
    const second = await share(owner, page.slug, ['again@corp.test'], { notify: false })
    const person = await unverified('again@corp.test')
    expect((await accept(person, page.slug, tokenOf(first.links[0].link))).status).toBe(404)
    expect((await accept(person, page.slug, tokenOf(second.links[0].link))).status).toBe(204)
  })

  it('emailed people get no link back; the others do', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    expect((await share(owner, page.slug, ['mailed@corp.test'])).links).toEqual([])
    expect((await share(owner, page.slug, ['quiet@corp.test'], { notify: false })).links).toEqual([
      { email: 'quiet@corp.test', link: expect.stringContaining(`/a/${page.slug}?share=`) },
    ])
  })

  it('deleting an unverified account leaves shares waiting for the address, except those it opened', async () => {
    const owner = await createUser()
    const waiting = await createPage(owner)
    const opened = await createPage(owner)
    await share(owner, waiting.slug, ['leaver@corp.test'])
    const { links } = await share(owner, opened.slug, ['leaver@corp.test'], { notify: false })
    const leaver = await unverified('leaver@corp.test')
    await accept(leaver, opened.slug, tokenOf(links[0].link))
    const res = await call('/api/me', { method: 'DELETE', cookie: leaver.cookie, json: { confirmEmail: 'leaver@corp.test' } })
    expect(res.status).toBe(204)
    const left = await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.email, 'leaver@corp.test'))
    expect(left).toHaveLength(1)
    expect(left[0].artifactId).toBe(waiting.id)
  })
})

describe('claiming an unverified account', () => {
  async function setUp() {
    const squatter = await unverified('ceo@corp.test', 'squatter password')
    const page = await createPage(squatter, { title: 'Kept' })
    const agent = await connectAgent(squatter)
    const created = await call('/api/me/access-tokens', { cookie: squatter.cookie, json: { name: 'CI', organizationId: null } })
    const { token: accessToken } = (await created.json()) as { token: string }
    await db.insert(schema.passkeys).values({ userId: squatter.id, credentialId: 'cred', publicKey: 'key', name: 'Their key' })
    await db.insert(schema.totpSecrets).values({ userId: squatter.id, secret: 'sealed', confirmedAt: new Date() })
    await db.insert(schema.recoveryCodes).values({ userId: squatter.id, codeHash: 'hash' })
    await db
      .insert(schema.webhooks)
      .values({ userId: squatter.id, url: 'https://hooks.example.com/x', format: 'json', events: ['page.published'], secret: 's' })
    return { squatter, page, agent, accessToken }
  }

  async function expectCleared({ squatter, page, agent, accessToken }: Awaited<ReturnType<typeof setUp>>) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, squatter.id))
    expect(user).toMatchObject({ emailUnverified: false })
    expect((await call('/api/me', { cookie: squatter.cookie })).status).toBe(401)
    expect((await call('/api/auth/password/login', { json: { email: 'ceo@corp.test', password: 'squatter password' } })).status).toBe(401)
    expect((await mcpRequest(agent.access_token, 'tools/list')).status).toBe(401)
    expect((await call('/api/whoami', { bearer: accessToken })).status).toBe(401)
    for (const table of [schema.passkeys, schema.totpSecrets, schema.recoveryCodes, schema.webhooks, schema.oauthGrants]) {
      expect(await db.select().from(table).where(eq(table.userId, squatter.id))).toEqual([])
    }
    // Their pages stay with the account
    expect(await db.select({ id: schema.artifacts.id }).from(schema.artifacts).where(eq(schema.artifacts.ownerId, squatter.id))).toEqual([{ id: page.id }])
  }

  it('by an email link removes everything the first holder could get back in with', async () => {
    const before = await setUp()
    expect((await call('/api/auth/email', { json: { email: 'ceo@corp.test' } })).status).toBe(204)
    const token = new URL(vi.mocked(sendSignInLink).mock.calls[0][1]).searchParams.get('token')
    const res = await call('/api/auth/email/confirm', { json: { token } })
    expect(res.status).toBe(200)
    // No second factor of theirs stands in the way: the session starts at once
    const cookie = sessionCookie(res)!
    expect(await (await call('/api/me', { cookie })).json()).toMatchObject({ email: 'ceo@corp.test', hasPassword: false })
    await expectCleared(before)
  })

  it('by Google does the same', async () => {
    const before = await setUp()
    const user = await findOrCreateUser({ email: 'ceo@corp.test', googleSub: 'google-ceo', method: 'google' })
    expect(user).toMatchObject({ id: before.squatter.id, googleSub: 'google-ceo', passwordHash: null })
    await expectCleared(before)
  })

  it('leaves an account whose address was checked alone', async () => {
    const owner = await createUser({ email: 'checked@corp.test' })
    await db.insert(schema.passkeys).values({ userId: owner.id, credentialId: 'cred', publicKey: 'key', name: 'Mine' })
    await findOrCreateUser({ email: 'checked@corp.test', googleSub: 'google-checked', method: 'google' })
    expect(await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, owner.id))).toHaveLength(1)
    expect((await call('/api/me', { cookie: owner.cookie })).status).toBe(200)
  })
})

describe('what sign-in tells someone who only types an address', () => {
  it('a wrong password answers the same with or without an account, or a password', async () => {
    await unverified('has@corp.test')
    await createUser({ email: 'nopassword@corp.test' })
    const answers = await Promise.all(
      ['has@corp.test', 'nopassword@corp.test', 'nobody@corp.test'].map(async (email) => {
        const res = await call('/api/auth/password/login', { json: { email, password: 'wrong password' } })
        return { status: res.status, body: await res.json() }
      }),
    )
    expect(answers[0]).toEqual({ status: 401, body: { error: 'The email or password is wrong.', code: 'wrong_password' } })
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
  })
})

describe('invitations', () => {
  it('an accept racing a revoke either joins or is refused, never both', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    for (let i = 0; i < 5; i++) {
      const joiner = await createUser()
      await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: joiner.email, role: 'member' } })
      const [invitation] = await db.select().from(schema.invitations).where(eq(schema.invitations.email, joiner.email))
      const [accepted, revoked] = await Promise.all([
        call(`/api/me/invitations/${invitation.id}/accept`, { cookie: joiner.cookie, method: 'POST' }),
        call(`/api/organizations/${org.id}/invitations/${invitation.id}`, { cookie: owner.cookie, method: 'DELETE' }),
      ])
      const joined = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, joiner.id))
      expect([accepted.status, revoked.status].sort()).toEqual([200, 404])
      expect(joined).toHaveLength(accepted.status === 200 ? 1 : 0)
    }
  })

  it('an invitation replaced by another at a lower role joins with the new role only', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const joiner = await createUser()
    const invite = (role: string) => call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email: joiner.email, role } })
    await invite('admin')
    const [first] = await db.select().from(schema.invitations)
    await invite('member')
    const res = await call(`/api/me/invitations/${first.id}/accept`, { cookie: joiner.cookie, method: 'POST' })
    expect(await res.json()).toMatchObject({ role: 'member' })
  })
})

describe('access tokens and passwords', () => {
  const age = (user: TestUser, ms: number) =>
    db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - ms) })
      .where(eq(schema.sessions.userId, user.id))

  it('making an access token needs a sign-in from the last hour', async () => {
    const user = await createUser()
    await age(user, 2 * 60 * 60 * 1000)
    const res = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI', organizationId: null } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'reauth_required', error: expect.stringContaining('create an access token') })
    expect(await db.select().from(schema.accessTokens)).toEqual([])
  })

  it('changing the password keeps agents and tokens, unless asked to sign them out too', async () => {
    const user = await createUser({ email: 'pw@corp.test' })
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword('first password') })
      .where(eq(schema.users.id, user.id))
    const agent = await connectAgent(user)
    const { token } = (await (await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI', organizationId: null } })).json()) as {
      token: string
    }

    const kept = await call('/api/me/password', {
      method: 'PUT',
      cookie: user.cookie,
      json: { currentPassword: 'first password', password: 'second password' },
    })
    expect(kept.status).toBe(204)
    expect((await mcpRequest(agent.access_token, 'tools/list')).status).toBe(200)
    expect((await call('/api/whoami', { bearer: token })).status).toBe(200)

    const cookie = sessionCookie(kept)!
    const res = await call('/api/me/password', {
      method: 'PUT',
      cookie,
      json: { currentPassword: 'second password', password: 'third password', signOutAgents: true },
    })
    expect(res.status).toBe(204)
    expect((await mcpRequest(agent.access_token, 'tools/list')).status).toBe(401)
    expect((await call('/api/whoami', { bearer: token })).status).toBe(401)
  })
})
