import { and, eq, gt } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env } from '../env.js'
import { adminFromEnvironment, firstAccountBecomesAdmin, instanceSettings, lockAdmins } from '../instance.js'

type Profile = {
  email: string
  name?: string | null
  avatarUrl?: string | null
  googleSub?: string
}

// `code` is the error the sign-in routes redirect to (/login?error=…)
export class SignupClosedError extends Error {
  code = 'signup_closed'
}

export class AccountSuspendedError extends SignupClosedError {
  code = 'account_suspended'
}

// The sign-up policy comes from the admin area's settings, or ALLOWED_EMAIL_DOMAINS until they
// are saved. In every mode people invited to an organization or a page can still join what they
// were invited to, and addresses in ADMIN_EMAILS can always sign up.
export async function canSignUp(email: string): Promise<boolean> {
  const { signupPolicy, allowedDomains } = await instanceSettings()
  if (signupPolicy === 'open') return true
  const address = email.toLowerCase()
  if (adminFromEnvironment(address)) return true
  if (signupPolicy === 'domains' && allowedDomains.includes(address.split('@')[1] ?? '')) return true
  const [invite] = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(and(eq(schema.invitations.email, address), gt(schema.invitations.expiresAt, new Date())))
    .limit(1)
  if (invite) return true
  const [share] = await db.select({ email: schema.artifactShares.email }).from(schema.artifactShares).where(eq(schema.artifactShares.email, address)).limit(1)
  return Boolean(share)
}

export async function userExists(email: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.toLowerCase()))
  return Boolean(row)
}

// Signing in and signing up are the same step: find the account by Google id or email, or create it
export async function findOrCreateUser(profile: Profile): Promise<User> {
  const email = profile.email.toLowerCase()

  if (profile.googleSub) {
    const [bySub] = await db.select().from(schema.users).where(eq(schema.users.googleSub, profile.googleSub))
    if (bySub) {
      if (bySub.suspendedAt) throw new AccountSuspendedError()
      return bySub
    }
  }

  const [byEmail] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (byEmail) {
    if (byEmail.suspendedAt) throw new AccountSuspendedError()
    if (profile.googleSub && !byEmail.googleSub) {
      const [linked] = await db
        .update(schema.users)
        .set({
          googleSub: profile.googleSub,
          name: byEmail.name ?? profile.name,
          avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl,
        })
        .where(eq(schema.users.id, byEmail.id))
        .returning()
      return linked
    }
    return byEmail
  }

  if (!(await canSignUp(email))) throw new SignupClosedError()
  return db.transaction(async (tx) => {
    // One account at a time, so only the very first one can become the instance admin
    await lockAdmins(tx)
    const [raced] = await tx.select().from(schema.users).where(eq(schema.users.email, email))
    if (raced) return raced
    const isAdmin = await firstAccountBecomesAdmin(tx)
    const [created] = await tx
      .insert(schema.users)
      .values({ email, name: profile.name, avatarUrl: profile.avatarUrl, googleSub: profile.googleSub, isAdmin })
      .returning()
    return created
  })
}

const PLANS = new Set(['organization'])

// Only same-site paths, so a crafted link can't send people elsewhere after signing in
export function safeNext(next: string | null | undefined): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null
}

export function afterSignInUrl(plan: string | null | undefined, next?: string | null): string {
  const target = safeNext(next)
  if (target) return new URL(target, env.appUrl).toString()
  const url = new URL('/app', env.appUrl)
  if (plan && PLANS.has(plan)) url.searchParams.set('plan', plan)
  return url.toString()
}

export function signInErrorUrl(error: string): string {
  const url = new URL('/login', env.appUrl)
  url.searchParams.set('error', error)
  return url.toString()
}
