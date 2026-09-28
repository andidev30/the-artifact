import { tryGetContext } from 'hono/context-storage'
import { clientAddress } from './limits.js'
import { log } from './log.js'

// The hook core code calls when something happens that an organization's audit log records. The
// log itself (storage, the Enterprise gate, the routes) is in src/ee/audit.ts, which app.ts plugs
// in with setAuditStore; without it, or without an Enterprise license, audit() records nothing.
// It never waits and never throws, so the action it records can't fail or slow down because of it.

export const AUDIT_ACTIONS = [
  'sign_in.succeeded',
  'sign_in.failed',
  'page.visibility_changed',
  'page.link_changed',
  'page.shared',
  'page.share_role_changed',
  'page.unshared',
  'member.invited',
  'member.invitation_revoked',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'member.left',
  'organization.settings_changed',
  'access_token.created',
  'access_token.revoked',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEvent = {
  action: AuditAction
  // Who did it; null when nobody is signed in
  actor: { id: string; email: string } | null
  target?: { type: 'page' | 'member' | 'invitation' | 'access_token' | 'organization'; id: string; label: string }
  details?: Record<string, unknown>
} & (
  | // The organization it happened in; null (a personal page, a personal token) records nothing
  { organizationId: string | null }
  // Every organization this account is in, for sign-ins
  | { memberOf: string }
)

// What the store gets: the event, with when and from where, taken while the request is still there
export type AuditEntry = AuditEvent & { at: Date; ip: string | null; userAgent: string | null }

export type AuditStore = { record: (entry: AuditEntry) => Promise<void> }

let store: AuditStore | null = null
const pending = new Set<Promise<void>>()

export function setAuditStore(s: AuditStore | null) {
  store = s
}

export function audit(event: AuditEvent): void {
  if (!store) return
  if ('organizationId' in event && !event.organizationId) return
  // The request, when there is one: app.ts runs every request inside contextStorage()
  const c = tryGetContext()
  const entry: AuditEntry = {
    ...event,
    at: new Date(),
    ip: c ? clientAddress(c) : null,
    userAgent: c?.req.header('user-agent')?.slice(0, 512) || null,
  }
  const done = store
    .record(entry)
    .catch((err) => log.error('Recording an audit event failed', { err, action: event.action }))
    .finally(() => pending.delete(done))
  pending.add(done)
}

// Resolves once every event handed to audit() so far is written, for tests and shutdown
export async function auditSettled(): Promise<void> {
  await Promise.all([...pending])
}
