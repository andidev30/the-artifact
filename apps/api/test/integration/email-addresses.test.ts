import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { sendInvitation, sendShareNotice, sendSignInLink } from '../../src/mail.js'
import { call, createOrg, createPage, createUser } from './helpers.js'

// Addresses that a mail library or a header could read as someone else's
const ODD = ['x<victim@example.com>', 'x"@example.com', 'a,victim@example.com', 'a;b@example.com', 'a@b@example.com', 'a@localhost']

describe('email addresses', () => {
  it('a new address has to be a plain one to get a sign-in link', async () => {
    for (const email of ODD) {
      const res = await call('/api/auth/email', { json: { email, intent: 'signup' } })
      expect(res.status, email).toBe(400)
    }
    expect(vi.mocked(sendSignInLink)).not.toHaveBeenCalled()
  })

  it('pages are shared and people invited only by plain addresses', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const org = await createOrg(owner)
    for (const email of ODD) {
      const share = await call(`/api/artifacts/${page.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: [email], role: 'viewer' } })
      expect(share.status, email).toBe(400)
      const invite = await call(`/api/organizations/${org.id}/invitations`, { cookie: owner.cookie, json: { email, role: 'member' } })
      expect(invite.status, email).toBe(400)
    }
    expect(vi.mocked(sendShareNotice)).not.toHaveBeenCalled()
    expect(vi.mocked(sendInvitation)).not.toHaveBeenCalled()
  })

  // Accounts are never rewritten: an address stored before the rule was tightened keeps signing in
  it('an account with an older, odd address still signs in', async () => {
    const odd = await createUser({ email: 'x"@example.com' })
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword('correct horse battery') })
      .where(eq(schema.users.id, odd.id))

    const login = await call('/api/auth/password/login', { json: { email: 'x"@example.com', password: 'correct horse battery' } })
    expect(login.status).toBe(200)

    const link = await call('/api/auth/email', { json: { email: 'x"@example.com' } })
    expect(link.status).toBe(204)
    expect(vi.mocked(sendSignInLink)).toHaveBeenCalledWith('x"@example.com', expect.any(String), 'login')
  })
})
