import { and, eq, inArray, sql } from 'drizzle-orm'
import { artifactUrl, pageTarget } from './artifacts.js'
import { track } from './analytics.js'
import { audit } from './audit.js'
import { hashToken, randomToken } from './auth/session.js'
import { db, schema } from './db/index.js'
import type { Artifact, ShareRole } from './db/schema.js'
import { mailEnabled } from './env.js'
import { mayEmailRecipient } from './limits.js'
import { linkSettings } from './links.js'
import { log } from './log.js'
import { sendShareNotice } from './mail.js'
import { isEmail } from './validation.js'

export const MAX_PEOPLE_PER_INVITE = 20

export class SharingError extends Error {}

export async function getSharing(artifact: Artifact) {
  const [owner] = await db
    .select({ name: schema.users.name, email: schema.users.email, avatarUrl: schema.users.avatarUrl })
    .from(schema.users)
    .where(eq(schema.users.id, artifact.ownerId))

  const shares = await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, artifact.id)).orderBy(schema.artifactShares.createdAt)
  const known = shares.length
    ? await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          avatarUrl: schema.users.avatarUrl,
          unverified: schema.users.emailUnverified,
        })
        .from(schema.users)
        .where(
          inArray(
            schema.users.email,
            shares.map((s) => s.email),
          ),
        )
    : []
  const byEmail = new Map(known.map((u) => [u.email, u]))

  const [org] = artifact.organizationId
    ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, artifact.organizationId))
    : []

  return {
    owner,
    people: shares.map((s) => {
      const account = byEmail.get(s.email)
      // The share counts for someone (accessLevel): an account whose address was checked, or the one that
      // opened the share's link. Until then the name is whatever the person who typed the address chose.
      const active = account !== undefined && (!account.unverified || s.acceptedBy === account.id)
      return {
        email: s.email,
        role: s.role,
        name: active ? account.name : null,
        avatarUrl: active ? account.avatarUrl : null,
        pending: !active,
      }
    }),
    visibility: artifact.visibility,
    link: linkSettings(artifact),
    organizationName: org?.name ?? null,
  }
}

export function parseEmails(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : []
  return [
    ...new Set(
      list
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

type Inviter = { id: string; name: string | null; email: string }

// The link the sharer passes on when nobody emailed the person. Opening it signed in with the address
// makes the share count for that account, even one whose address nobody checked (acceptShare).
export type ShareLink = { email: string; link: string }

function shareUrl(slug: string, token: string) {
  const url = new URL(artifactUrl(slug))
  url.searchParams.set('share', token)
  return url.toString()
}

export async function sharePeople(artifact: Artifact, inviter: Inviter, emails: string[], role: ShareRole, notify: boolean, message?: string) {
  if (emails.length === 0) throw new SharingError('Add at least one email address.')
  if (emails.length > MAX_PEOPLE_PER_INVITE) throw new SharingError(`Share with up to ${MAX_PEOPLE_PER_INVITE} people at a time.`)
  const invalid = emails.filter((e) => !isEmail(e))
  if (invalid.length) throw new SharingError(`These don't look like email addresses: ${invalid.join(', ')}`)

  const [owner] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId))
  const targets = emails.filter((e) => e !== owner?.email)
  if (targets.length === 0) throw new SharingError('The owner already has access.')

  // Sharing with an address again makes a new link, and the one before stops working
  const tokens = new Map(targets.map((email) => [email, randomToken()]))
  await db
    .insert(schema.artifactShares)
    .values(targets.map((email) => ({ artifactId: artifact.id, email, role, invitedBy: inviter.id, tokenHash: hashToken(tokens.get(email)!) })))
    .onConflictDoUpdate({
      target: [schema.artifactShares.artifactId, schema.artifactShares.email],
      set: { role, tokenHash: sql`excluded.token_hash` },
    })
  audit({
    action: 'page.shared',
    organizationId: artifact.organizationId,
    actor: { id: inviter.id, email: inviter.email },
    target: pageTarget(artifact),
    details: { people: targets, role },
  })
  track({ event: 'page_shared', userId: inviter.id, detail: 'person' })

  // Without email there is nothing to send; the sharer passes the links on
  const emailed = new Set<string>()
  const notifyFailed: string[] = []
  if (notify && mailEnabled()) {
    const from = inviter.name ?? inviter.email
    // An address that got many invitations and shares today isn't emailed again; its link goes back to the sharer
    const recipients: string[] = []
    for (const to of targets) if (await mayEmailRecipient(to)) recipients.push(to)
    // One failed address shouldn't undo the share; report it instead
    const results = await Promise.allSettled(
      recipients.map((to) => sendShareNotice(to, { from, title: artifact.title, link: artifactUrl(artifact.slug), role, message: message?.slice(0, 500) })),
    )
    for (const [i, to] of recipients.entries()) {
      if (results[i].status === 'fulfilled') emailed.add(to)
      else notifyFailed.push(to)
    }
    if (notifyFailed.length) log.error('Share notice failed', { artifactId: artifact.id, failed: notifyFailed.length })
  }
  const links: ShareLink[] = targets.filter((email) => !emailed.has(email)).map((email) => ({ email, link: shareUrl(artifact.slug, tokens.get(email)!) }))
  return { shared: targets, notifyFailed, links }
}

// Opening a share's link while signed in with its address. Links work once.
export async function acceptShare(artifact: Artifact, token: string, user: { id: string; email: string }): Promise<boolean> {
  const accepted = await db
    .update(schema.artifactShares)
    .set({ acceptedBy: user.id, tokenHash: null })
    .where(
      and(
        eq(schema.artifactShares.artifactId, artifact.id),
        eq(schema.artifactShares.tokenHash, hashToken(token)),
        eq(schema.artifactShares.email, user.email.toLowerCase()),
      ),
    )
    .returning({ email: schema.artifactShares.email })
  return accepted.length > 0
}

type Actor = { id: string; email: string }

export async function setPersonRole(artifact: Artifact, email: string, role: ShareRole, actor: Actor) {
  const updated = await db
    .update(schema.artifactShares)
    .set({ role })
    .where(and(eq(schema.artifactShares.artifactId, artifact.id), eq(schema.artifactShares.email, email.toLowerCase())))
    .returning()
  if (!updated.length) throw new SharingError('That person does not have access to this page.')
  audit({
    action: 'page.share_role_changed',
    organizationId: artifact.organizationId,
    actor: { id: actor.id, email: actor.email },
    target: pageTarget(artifact),
    details: { person: email.toLowerCase(), role },
  })
}

export async function removePerson(artifact: Artifact, email: string, actor: Actor) {
  const removed = await db
    .delete(schema.artifactShares)
    .where(and(eq(schema.artifactShares.artifactId, artifact.id), eq(schema.artifactShares.email, email.toLowerCase())))
    .returning({ email: schema.artifactShares.email })
  if (!removed.length) return
  audit({
    action: 'page.unshared',
    organizationId: artifact.organizationId,
    actor: { id: actor.id, email: actor.email },
    target: pageTarget(artifact),
    details: { person: removed[0].email },
  })
}
