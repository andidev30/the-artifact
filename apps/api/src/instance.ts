import { and, count, eq, isNull, ne, sql, type SQL } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import type { SignupPolicy, User } from './db/schema.js'
import { env } from './env.js'

// Instance administration: who runs this install, and the settings they edit in the web app.

// Serializes creating accounts and changing admins, so two sign-ups at once can't both become
// the first admin and two admins can't remove each other at the same moment.
const ADMIN_LOCK = 7_314_001

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function lockAdmins(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADMIN_LOCK})`)
}

// Suspended people aren't admins
export function isInstanceAdmin(user: Pick<User, 'isAdmin' | 'suspendedAt'>): boolean {
  return !user.suspendedAt && user.isAdmin
}

// SQL for "this user row is an admin", matching isInstanceAdmin
export function adminCondition(): SQL {
  return and(isNull(schema.users.suspendedAt), eq(schema.users.isAdmin, true))!
}

export async function activeAdminCount(tx: Tx | typeof db = db): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(schema.users).where(adminCondition())
  return row.n
}

// Whether a new account should be the instance admin: only the very first one, and only on a
// self-hosted install. Call inside the transaction holding lockAdmins.
export async function firstAccountBecomesAdmin(tx: Tx): Promise<boolean> {
  if (!env.selfHosted) return false
  return !(await hasAccounts(tx))
}

export async function hasAccounts(tx: Tx | typeof db = db): Promise<boolean> {
  const [any] = await tx.select({ id: schema.users.id }).from(schema.users).limit(1)
  return Boolean(any)
}

// Settings

export type EffectiveSettings = {
  signupPolicy: SignupPolicy
  allowedDomains: string[]
  instanceName: string | null
  updatedAt: string | null
}

export async function instanceSettings(): Promise<EffectiveSettings> {
  const [row] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1))
  if (row) {
    return {
      signupPolicy: row.signupPolicy,
      allowedDomains: row.allowedDomains,
      instanceName: row.instanceName,
      updatedAt: row.updatedAt.toISOString(),
    }
  }
  // Until an admin saves the form, anyone who can reach the server may sign up
  return { signupPolicy: 'open', allowedDomains: [], instanceName: null, updatedAt: null }
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const POLICIES: SignupPolicy[] = ['open', 'domains', 'invite-only']

export type SettingsInput = { signupPolicy: SignupPolicy; allowedDomains: string[]; instanceName: string | null }

// Validates what the admin form sends; returns the clean values or an error for one field
export function parseSettings(body: unknown): { ok: true; value: SettingsInput } | { ok: false; error: string; field: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const policy = b.signupPolicy as SignupPolicy
  if (!POLICIES.includes(policy)) return { ok: false, error: 'Choose who can sign up.', field: 'signupPolicy' }

  const raw = Array.isArray(b.allowedDomains) ? b.allowedDomains : typeof b.allowedDomains === 'string' ? b.allowedDomains.split(/[\s,]+/) : []
  const domains: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'List domains like example.com.', field: 'allowedDomains' }
    const d = item.trim().toLowerCase().replace(/^@/, '')
    if (!d) continue
    if (!DOMAIN_RE.test(d)) return { ok: false, error: `${d} is not a domain. List domains like example.com.`, field: 'allowedDomains' }
    if (!domains.includes(d)) domains.push(d)
  }
  if (domains.length > 100) return { ok: false, error: 'List at most 100 domains.', field: 'allowedDomains' }
  if (policy === 'domains' && domains.length === 0) return { ok: false, error: 'Add at least one domain.', field: 'allowedDomains' }

  let name: string | null = null
  if (b.instanceName !== undefined && b.instanceName !== null) {
    if (typeof b.instanceName !== 'string') return { ok: false, error: 'Use text for the name.', field: 'instanceName' }
    name = b.instanceName.trim().replace(/\s+/g, ' ') || null
    if (name && name.length > 60) return { ok: false, error: 'Use at most 60 characters for the name.', field: 'instanceName' }
  }
  return { ok: true, value: { signupPolicy: policy, allowedDomains: domains, instanceName: name } }
}

export async function saveSettings(value: SettingsInput, updatedBy: string) {
  const row = { ...value, updatedBy, updatedAt: new Date() }
  await db.insert(schema.instanceSettings).values({ id: 1, ...row }).onConflictDoUpdate({ target: schema.instanceSettings.id, set: row })
}

// Everything a suspended person could still act through: web sessions, agent tokens, grants
// in progress and unused sign-in links
export async function revokeAccess(tx: Tx, user: Pick<User, 'id' | 'email'>) {
  await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id))
  await tx.delete(schema.oauthTokens).where(eq(schema.oauthTokens.userId, user.id))
  await tx.delete(schema.oauthGrants).where(eq(schema.oauthGrants.userId, user.id))
  await tx.delete(schema.emailTokens).where(eq(schema.emailTokens.email, user.email))
}

export const lastAdminError = {
  error: 'You are the only admin of this instance. Make someone else an admin before you delete your account.',
  code: 'last_admin',
}

// True when deleting this person would leave an instance with other people but no admin
export async function isLastAdmin(user: Pick<User, 'id' | 'isAdmin' | 'suspendedAt'>): Promise<boolean> {
  if (!isInstanceAdmin(user) || (await activeAdminCount()) > 1) return false
  const [other] = await db.select({ id: schema.users.id }).from(schema.users).where(ne(schema.users.id, user.id)).limit(1)
  return Boolean(other)
}
