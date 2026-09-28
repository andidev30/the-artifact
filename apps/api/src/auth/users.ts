import { and, eq, gt } from 'drizzle-orm'
import { track, type SignUpMethod } from '../analytics.js'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env } from '../env.js'
import { instanceSettings, lockAdmins, newAccountFields } from '../instance.js'

type Profile = {
  email: string
  name?: string | null
  avatarUrl?: string | null
  googleSub?: string
  // For accounts made from a link on servers without email: set as the password, replacing any old one
  passwordHash?: string
  // An instance admin made the link, so the sign-up policy doesn't apply
  approved?: boolean
  // How a new account was made, for the hosted service's sign-up funnel
  method: SignUpMethod
}

// `code` is the error the sign-in routes redirect to (/login?error=…)
export class SignupClosedError extends Error {
  code = 'signup_closed'
}

export class AccountSuspendedError extends SignupClosedError {
  code = 'account_suspended'
}

// The sign-up policy comes from the admin area's settings (anyone, until they are saved). In every
// mode people invited to an organization or a page can still join what they were invited to.
export async function canSignUp(email: string): Promise<boolean> {
  const { signupPolicy, allowedDomains } = await instanceSettings()
  if (signupPolicy === 'open') return true
  const address = email.toLowerCase()
  if (signupPolicy === 'domains' && allowedDomains.includes(address.split('@')[1] ?? '')) return true
  return waitingForAccess(address)
}

// Whether an organization invitation or a page share is waiting for this address
export async function waitingForAccess(email: string): Promise<boolean> {
  const address = email.toLowerCase()
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

  const [found] = await db.select().from(schema.users).where(eq(schema.users.email, email))
  if (found) {
    if (found.suspendedAt) throw new AccountSuspendedError()
    // Every way in here proves the address: an email link, Google's verified email, or single sign-on
    const byEmail = found.emailUnverified
      ? (await db.update(schema.users).set({ emailUnverified: false }).where(eq(schema.users.id, found.id)).returning())[0]
      : found
    if (profile.passwordHash) {
      // A new password signs the person out everywhere else
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, byEmail.id))
      await db.delete(schema.pendingSignIns).where(eq(schema.pendingSignIns.userId, byEmail.id))
      const [updated] = await db.update(schema.users).set({ passwordHash: profile.passwordHash }).where(eq(schema.users.id, byEmail.id)).returning()
      return updated
    }
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

  if (!profile.approved && !(await canSignUp(email))) throw new SignupClosedError()
  const { user, created } = await db.transaction(async (tx) => {
    // One account at a time, so only the very first one can become the instance admin
    await lockAdmins(tx)
    const [raced] = await tx.select().from(schema.users).where(eq(schema.users.email, email))
    if (raced) return { user: raced, created: false }
    const [created] = await tx
      .insert(schema.users)
      .values({
        email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        googleSub: profile.googleSub,
        passwordHash: profile.passwordHash,
        ...(await newAccountFields(tx)),
      })
      .returning()
    return { user: created, created: true }
  })
  if (created) track({ event: 'signed_up', userId: user.id, detail: profile.method })
  return user
}

const PLANS = new Set(['organization'])

// Only same-site paths, so a crafted link can't send people elsewhere after signing in
export function safeNext(next: string | null | undefined): string | null {
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null
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

// A new account with a password, or null when the address already has one. Never touches an
// existing account, unlike findOrCreateUser.
// unverified: the person typed the address themselves and nothing checked it (see emailUnverified).
export async function createPasswordAccount(email: string, name: string | null, passwordHash: string, unverified = false): Promise<User | null> {
  const user = await db.transaction(async (tx) => {
    await lockAdmins(tx)
    const [taken] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
    if (taken) return null
    const [created] = await tx
      .insert(schema.users)
      .values({ email, name, passwordHash, emailUnverified: unverified, ...(await newAccountFields(tx)) })
      .returning()
    return created
  })
  if (user) track({ event: 'signed_up', userId: user.id, detail: 'password' })
  return user
}
