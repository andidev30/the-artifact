import { and, eq, inArray } from 'drizzle-orm'
import { artifactUrl, pageTarget } from './artifacts.js'
import { track } from './analytics.js'
import { audit } from './audit.js'
import { db, schema } from './db/index.js'
import type { Artifact, ShareRole } from './db/schema.js'
import { mailEnabled } from './env.js'
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
        .select({ email: schema.users.email, name: schema.users.name, avatarUrl: schema.users.avatarUrl })
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
    people: shares.map((s) => ({
      email: s.email,
      role: s.role,
      name: byEmail.get(s.email)?.name ?? null,
      avatarUrl: byEmail.get(s.email)?.avatarUrl ?? null,
      // Invited before they have an account
      pending: !byEmail.has(s.email),
    })),
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

export async function sharePeople(artifact: Artifact, inviter: Inviter, emails: string[], role: ShareRole, notify: boolean, message?: string) {
  if (emails.length === 0) throw new SharingError('Add at least one email address.')
  if (emails.length > MAX_PEOPLE_PER_INVITE) throw new SharingError(`Share with up to ${MAX_PEOPLE_PER_INVITE} people at a time.`)
  const invalid = emails.filter((e) => !isEmail(e))
  if (invalid.length) throw new SharingError(`These don't look like email addresses: ${invalid.join(', ')}`)

  const [owner] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, artifact.ownerId))
  const targets = emails.filter((e) => e !== owner?.email)
  if (targets.length === 0) throw new SharingError('The owner already has access.')

  await db
    .insert(schema.artifactShares)
    .values(targets.map((email) => ({ artifactId: artifact.id, email, role, invitedBy: inviter.id })))
    .onConflictDoUpdate({ target: [schema.artifactShares.artifactId, schema.artifactShares.email], set: { role } })
  audit({
    action: 'page.shared',
    organizationId: artifact.organizationId,
    actor: { id: inviter.id, email: inviter.email },
    target: pageTarget(artifact),
    details: { people: targets, role },
  })
  track({ event: 'page_shared', userId: inviter.id, detail: 'person' })

  // Without email there is nothing to send; the sharer passes the link on
  if (notify && mailEnabled()) {
    const from = inviter.name ?? inviter.email
    // One failed address shouldn't undo the share; report it instead
    const results = await Promise.allSettled(
      targets.map((to) => sendShareNotice(to, { from, title: artifact.title, link: artifactUrl(artifact.slug), role, message: message?.slice(0, 500) })),
    )
    const failed = targets.filter((_, i) => results[i].status === 'rejected')
    if (failed.length) log.error('Share notice failed', { artifactId: artifact.id, failed: failed.length })
    return { shared: targets, notifyFailed: failed }
  }
  return { shared: targets, notifyFailed: [] }
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
