import { and, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env, mailEnabled, normalizeSetupCode } from '../env.js'
import { needsSetupCode } from '../instance.js'
import { clientIp, limitRequest } from '../limits.js'
import { log } from '../log.js'
import { sendSignInLink } from '../mail.js'
import { setupCodeMatches } from '../setup-code.js'
import { isAccountEmail, isEmail } from '../validation.js'
import { hashPassword, passwordProblem, SETUP_CODE_MISSING, SETUP_CODE_WRONG } from './password.js'
import { hashToken, randomToken } from './session.js'
import { continueSignIn } from './twofactor.js'
import { afterSignInUrl, canSignUp, findOrCreateUser, safeNext, signInErrorUrl, SignupClosedError, userExists } from './users.js'

const LINK_TTL = 15 * 60 * 1000
// Links an admin makes to pass on by hand last longer than emailed ones
const ADMIN_LINK_DAYS = 7
// Don't send another link to the same address within this window
const RESEND_AFTER = 60 * 1000

export const email = new Hono()

email.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: unknown; intent?: unknown; plan?: unknown; next?: unknown } | null
  const address = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!mailEnabled()) {
    return c.json({ error: 'This server can’t send email. Log in with your password, or ask an admin for a sign-in link.', code: 'email_disabled' }, 503)
  }
  const busy = await limitRequest(c, 'sign-in-link-ip', clientIp(c), 'Too many sign-in links were asked for from your network.')
  if (busy) return busy
  if (!isAccountEmail(address)) return c.json({ error: 'Enter a valid email address.' }, 400)
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, address))
  // An account from before EMAIL_RE was tightened still gets its link; a new address has to pass it
  if (!existing && !isEmail(address)) return c.json({ error: 'Enter a valid email address.' }, 400)
  // A suspended account gets its link like any other, and using it says the account is suspended: only
  // whoever reads the mailbox learns that, not anyone who types the address here
  if (!existing && !(await canSignUp(address))) {
    return c.json(
      { error: 'This server only accepts accounts from invited people and certain email domains. Ask an admin to invite you.', code: 'signup_closed' },
      403,
    )
  }
  const intent = body?.intent === 'signup' ? 'signup' : 'login'
  const plan = typeof body?.plan === 'string' ? body.plan : null

  const [recent] = await db
    .select({ id: schema.emailTokens.id })
    .from(schema.emailTokens)
    .where(and(eq(schema.emailTokens.email, address), gt(schema.emailTokens.createdAt, new Date(Date.now() - RESEND_AFTER))))
  if (recent) return c.body(null, 204)
  const flooded = await limitRequest(c, 'sign-in-link', address, 'Too many sign-in links were sent to this address.')
  if (flooded) return flooded

  const token = randomToken()
  await db.insert(schema.emailTokens).values({
    id: hashToken(token),
    email: address,
    expiresAt: new Date(Date.now() + LINK_TTL),
  })

  const next = safeNext(typeof body?.next === 'string' ? body.next : null)
  const link = confirmUrl(token, plan, next)

  try {
    await sendSignInLink(address, link, intent)
  } catch (err) {
    log.error('Sending sign-in email failed', { err })
    return c.json({ error: 'The link could not be sent.' }, 502)
  }
  return c.body(null, 204)
})

export type AdminLink = { email: string; link: string; newAccount: boolean; expiresAt: string }

// A sign-in link an instance admin passes on by hand, for servers that can't send email. Opening it
// asks for a new password; for someone without an account it creates one whatever the sign-up policy.
export async function createAdminLink(rawEmail: string, adminId: string): Promise<{ ok: true; link: AdminLink } | { ok: false; error: string }> {
  const address = rawEmail.trim().toLowerCase()
  if (!isAccountEmail(address)) return { ok: false, error: 'Enter a valid email address.' }
  const [existing] = await db.select({ suspendedAt: schema.users.suspendedAt }).from(schema.users).where(eq(schema.users.email, address))
  if (!existing && !isEmail(address)) return { ok: false, error: 'Enter a valid email address.' }
  if (existing?.suspendedAt) return { ok: false, error: `${address} is suspended. Restore the account first.` }
  // Only the newest link for an address works
  await db.delete(schema.emailTokens).where(eq(schema.emailTokens.email, address))
  const token = randomToken()
  const expiresAt = new Date(Date.now() + ADMIN_LINK_DAYS * 24 * 60 * 60 * 1000)
  await db.insert(schema.emailTokens).values({ id: hashToken(token), email: address, expiresAt, createdBy: adminId })
  return { ok: true, link: { email: address, link: confirmUrl(token, null, null), newAccount: !existing, expiresAt: expiresAt.toISOString() } }
}

// Links made by an admin, and every link on a server without email, set a password when used
function setsPassword(row: { createdBy: string | null }) {
  return Boolean(row.createdBy) || !mailEnabled()
}

// The emailed link opens a page in the web app that asks the person to continue.
// Opening it must not use the link up: email security scanners open links before people do.
function confirmUrl(token: string, plan: string | null | undefined, next: string | null | undefined): string {
  const url = new URL('/auth/confirm', env.appUrl)
  url.searchParams.set('token', token)
  if (plan) url.searchParams.set('plan', plan)
  const target = safeNext(next)
  if (target) url.searchParams.set('next', target)
  return url.toString()
}

async function findToken(token: string) {
  const [row] = await db
    .select()
    .from(schema.emailTokens)
    .where(eq(schema.emailTokens.id, hashToken(token)))
  return row ?? null
}

// Links sent before the confirmation page existed pointed here; send them to the page without using them up
email.get('/verify', (c) => {
  const token = c.req.query('token')
  if (!token) return c.redirect(signInErrorUrl('link_invalid'))
  return c.redirect(confirmUrl(token, c.req.query('plan'), c.req.query('next')))
})

// What the confirmation page shows. Read only: it never uses the link or starts a session.
email.get('/confirm', async (c) => {
  const token = c.req.query('token')
  const row = token ? await findToken(token) : null
  if (!row) {
    return c.json({ error: 'This sign-in link has already been used or is not valid.', code: 'link_invalid' }, 404)
  }
  const newAccount = !(await userExists(row.email))
  return c.json({
    email: row.email,
    expired: row.expiresAt.getTime() < Date.now(),
    newAccount,
    setPassword: setsPassword(row),
    emailEnabled: mailEnabled(),
    // The first account on a self-hosted install: the page asks for the setup code from the server log
    setupCode: newAccount && (await needsSetupCode()),
  })
})

// Pressing Continue on the confirmation page: uses the link once, starts a session and says where to go
email.post('/confirm', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { token?: unknown; plan?: unknown; next?: unknown; password?: unknown; setupCode?: unknown } | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!token) return c.json({ error: 'This sign-in link has already been used or is not valid.', code: 'link_invalid' }, 400)
  const setupCode = typeof body?.setupCode === 'string' ? body.setupCode : undefined

  // Checked before the link is used up, so a mistyped setup code or a too-short password doesn't cost
  // the person their link. newAccountFields checks the code again as it creates the account.
  const pending = await findToken(token)
  if (pending && !(await userExists(pending.email)) && (await needsSetupCode())) {
    if (!normalizeSetupCode(setupCode)) return c.json({ error: SETUP_CODE_MISSING, field: 'setupCode' }, 400)
    const busy = await limitRequest(c, 'password-ip', clientIp(c), 'Too many sign-in attempts from your network.')
    if (busy) return busy
    if (!(await setupCodeMatches(setupCode))) return c.json({ error: SETUP_CODE_WRONG, field: 'setupCode' }, 400)
  }
  let passwordHash: string | undefined
  if (pending && setsPassword(pending)) {
    const problem = passwordProblem(body?.password)
    if (problem) return c.json({ error: problem, field: 'password' }, 400)
    passwordHash = await hashPassword(body!.password as string)
  }

  // Links work once: delete the token as it is read
  const [row] = await db
    .delete(schema.emailTokens)
    .where(eq(schema.emailTokens.id, hashToken(token)))
    .returning()
  if (!row) return c.json({ error: 'This sign-in link has already been used or is not valid.', code: 'link_invalid' }, 400)
  if (row.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'This sign-in link has expired.', code: 'link_expired', email: row.email }, 410)
  }

  let user: User
  try {
    user = await findOrCreateUser({ email: row.email, passwordHash, approved: Boolean(row.createdBy), method: 'email_link', setupCode })
  } catch (err) {
    if (err instanceof SignupClosedError) {
      const error =
        err.code === 'account_suspended'
          ? 'This account is suspended. Ask an admin of this server to restore it.'
          : err.code === 'needs_setup'
            ? `${SETUP_CODE_WRONG} Then ask for a new link.`
            : 'This server only accepts accounts from invited people and certain email domains. Ask an admin to invite you.'
      return c.json({ error, code: err.code }, 403)
    }
    throw err
  }
  const plan = typeof body?.plan === 'string' ? body.plan : null
  const next = typeof body?.next === 'string' ? body.next : null
  // An email link is one factor: an account with a second factor still needs it, even when the link came from an admin
  return c.json({ redirect: await continueSignIn(c, user, afterSignInUrl(plan, next), 'email link') })
})
