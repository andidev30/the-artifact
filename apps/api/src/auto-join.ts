import { and, asc, eq, isNull } from 'drizzle-orm'
import { track } from './analytics.js'
import { audit } from './audit.js'
import { db, schema } from './db/index.js'
import { DOMAIN_RE } from './instance.js'
import { log } from './log.js'
import { UUID_RE } from './validation.js'

// Joining an organization by email domain. An instance admin picks one organization and the domains
// whose people belong in it; an account with a checked address at one of them joins as a member when
// it signs up or signs in, or when its address is checked. Once per account and organization: the
// auto_joins row stays when they leave or are removed, so they aren't pulled back in.
// Only instance admins set this. Nothing proves that an organization owns a domain, so letting its
// owners list one would let them claim everyone at, say, gmail.com.

export type AutoJoinSettings = {
  organization: { id: string; name: string; slug: string } | null
  domains: string[]
  updatedAt: string | null
}

export async function autoJoinSettings(): Promise<AutoJoinSettings> {
  const [row] = await db
    .select({
      domains: schema.instanceSettings.autoJoinDomains,
      updatedAt: schema.instanceSettings.autoJoinUpdatedAt,
      org: { id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug },
    })
    .from(schema.instanceSettings)
    .leftJoin(schema.organizations, eq(schema.instanceSettings.autoJoinOrganizationId, schema.organizations.id))
    .where(eq(schema.instanceSettings.id, 1))
  if (!row) return { organization: null, domains: [], updatedAt: null }
  return { organization: row.org, domains: row.domains, updatedAt: row.updatedAt?.toISOString() ?? null }
}

// The organizations an admin can choose from, by name. A server with more than this many can still
// keep the one it chose, which autoJoinSettings returns.
const CHOICES = 1000

export async function organizationChoices() {
  return db
    .select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug })
    .from(schema.organizations)
    .orderBy(asc(schema.organizations.name), schema.organizations.id)
    .limit(CHOICES)
}

export type AutoJoinInput = { organizationId: string | null; domains: string[] }

// Validates what the admin form sends; the organization must exist
export async function parseAutoJoin(body: unknown): Promise<{ ok: true; value: AutoJoinInput } | { ok: false; error: string; field: string }> {
  const b = (body ?? {}) as Record<string, unknown>
  let organizationId: string | null = null
  if (b.organizationId !== undefined && b.organizationId !== null && b.organizationId !== '') {
    const id = b.organizationId
    const [org] =
      typeof id === 'string' && UUID_RE.test(id)
        ? await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, id))
        : []
    if (!org) return { ok: false, error: 'Choose an organization on this server.', field: 'organizationId' }
    organizationId = org.id
  }

  const raw = Array.isArray(b.domains) ? b.domains : typeof b.domains === 'string' ? b.domains.split(/[\s,]+/) : []
  const domains: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'List domains like example.com.', field: 'domains' }
    const d = item.trim().toLowerCase().replace(/^@/, '')
    if (!d) continue
    if (!DOMAIN_RE.test(d)) return { ok: false, error: `${d} is not a domain. List domains like example.com.`, field: 'domains' }
    if (!domains.includes(d)) domains.push(d)
  }
  if (domains.length > 100) return { ok: false, error: 'List at most 100 domains.', field: 'domains' }
  if (organizationId && domains.length === 0) return { ok: false, error: 'Add at least one domain.', field: 'domains' }
  return { ok: true, value: { organizationId, domains } }
}

export async function saveAutoJoin(value: AutoJoinInput) {
  const set = { autoJoinOrganizationId: value.organizationId, autoJoinDomains: value.domains, autoJoinUpdatedAt: new Date() }
  await db
    .insert(schema.instanceSettings)
    // Without a row, anyone may sign up; saving this keeps it that way
    .values({ id: 1, signupPolicy: 'open', ...set })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set })
}

// The part after the last @, which is what a mail server delivers by. Only exact matches count:
// listing example.com doesn't take in mail.example.com.
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

// Adds the account to the chosen organization when its checked address is at a listed domain and it
// wasn't evaluated for that organization before. Call it wherever an account is signed in or gets its
// address checked; it never throws, so a sign-in can't fail because of it.
export async function autoJoin(userId: string): Promise<void> {
  try {
    const [setting] = await db
      .select({ organizationId: schema.instanceSettings.autoJoinOrganizationId, domains: schema.instanceSettings.autoJoinDomains })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
    const organizationId = setting?.organizationId
    if (!organizationId || !setting.domains.length) return
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
    // An address nobody checked may belong to someone else (see users.emailUnverified)
    if (!user || user.emailUnverified || user.suspendedAt) return
    const domain = emailDomain(user.email)
    if (!setting.domains.includes(domain)) return

    const joined = await db.transaction(async (tx) => {
      // Taken first, so of two sign-ins at once only one goes on
      const [first] = await tx
        .insert(schema.autoJoins)
        .values({ userId: user.id, organizationId, domain })
        .onConflictDoNothing()
        .returning({ userId: schema.autoJoins.userId })
      if (!first) return false
      const added = await tx
        .insert(schema.memberships)
        .values({ userId: user.id, organizationId, role: 'member' })
        .onConflictDoNothing()
        .returning({ role: schema.memberships.role })
      if (!added.length) {
        // A member already, with whatever role they have: nothing to tell them
        await tx
          .update(schema.autoJoins)
          .set({ noticeSeenAt: new Date() })
          .where(and(eq(schema.autoJoins.userId, user.id), eq(schema.autoJoins.organizationId, organizationId)))
        return false
      }
      // Joining an organization counts as setting up a workspace, as an invitation does
      if (!user.onboardedAt) await tx.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, user.id))
      return true
    })
    if (!joined) return
    if (!user.onboardedAt) track({ event: 'onboarded', userId: user.id, detail: 'email domain' })
    audit({
      action: 'member.joined',
      organizationId,
      actor: { id: user.id, email: user.email },
      target: { type: 'member', id: user.id, label: user.email },
      details: { role: 'member', via: 'email domain', domain },
    })
  } catch (err) {
    log.error('Joining an organization by email domain failed', { err, userId })
  }
}

// Organizations this person joined by domain and hasn't dismissed the notice for, while still a member
export async function autoJoinNotices(userId: string) {
  return db
    .select({ organizationId: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug, domain: schema.autoJoins.domain })
    .from(schema.autoJoins)
    .innerJoin(schema.organizations, eq(schema.autoJoins.organizationId, schema.organizations.id))
    .innerJoin(
      schema.memberships,
      and(eq(schema.memberships.organizationId, schema.autoJoins.organizationId), eq(schema.memberships.userId, schema.autoJoins.userId)),
    )
    .where(and(eq(schema.autoJoins.userId, userId), isNull(schema.autoJoins.noticeSeenAt)))
    .orderBy(schema.autoJoins.createdAt)
}

export async function dismissAutoJoinNotice(userId: string, organizationId: string) {
  await db
    .update(schema.autoJoins)
    .set({ noticeSeenAt: new Date() })
    .where(and(eq(schema.autoJoins.userId, userId), eq(schema.autoJoins.organizationId, organizationId), isNull(schema.autoJoins.noticeSeenAt)))
}
