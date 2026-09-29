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
  'page.moved_in',
  'page.moved_out',
  'page.deleted',
  'member.invited',
  'member.invitation_revoked',
  'member.joined',
  'member.added',
  'member.role_changed',
  'member.removed',
  'member.left',
  'member.suspended',
  'member.reactivated',
  'organization.settings_changed',
  'organization.retention_changed',
  'organization.export_requested',
  'organization.export_downloaded',
  'agent.connected',
  'agent.disconnected',
  'access_token.created',
  'access_token.revoked',
  'webhook.created',
  'webhook.changed',
  'webhook.deleted',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEvent = {
  action: AuditAction
  // Who did it; null when nobody is signed in
  actor: { id: string; email: string } | null
  target?: { type: 'page' | 'member' | 'invitation' | 'access_token' | 'organization' | 'webhook' | 'agent'; id: string; label: string }
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

// Security events outside any organization's audit log, written whatever the license: what instance
// admins do (there is no instance-level audit log), deleting accounts and organizations (an
// organization's audit log goes with it), and changes to how someone signs in. One JSON line each
// in the server log, with a fixed `event` to filter on; docs/security.md lists them. Warnings for
// what admins do and what deletes data, information for people's own sign-in settings.
const SECURITY_EVENTS = {
  'admin.granted': ['Instance admin granted', 'warn'],
  'admin.revoked': ['Instance admin removed', 'warn'],
  'user.suspended': ['Account suspended by an admin', 'warn'],
  'user.reactivated': ['Account reactivated by an admin', 'warn'],
  'user.deleted': ['Account deleted by an admin', 'warn'],
  'user.two_factor_reset': ['Two-factor sign-in reset by an admin', 'warn'],
  'user.sign_in_link_created': ['Sign-in link made by an admin', 'warn'],
  'organization.deleted': ['Organization deleted', 'warn'],
  'instance.settings_changed': ['Instance settings changed', 'warn'],
  'license.changed': ['License key entered', 'warn'],
  'license.removed': ['License key removed', 'warn'],
  'scim_token.created': ['SCIM token created', 'warn'],
  'scim_token.revoked': ['SCIM token revoked', 'warn'],
  'sso_connection.added': ['SSO connection added', 'warn'],
  'sso_connection.changed': ['SSO connection changed', 'warn'],
  'sso_connection.removed': ['SSO connection removed', 'warn'],
  'sso.link_refused': ['SSO sign-in refused to link an existing account', 'warn'],
  'account.deleted': ['Account deleted', 'warn'],
  'account.password_changed': ['Password changed', 'info'],
  'account.password_added': ['Password added', 'info'],
  'account.passkey_added': ['Passkey added', 'info'],
  'account.passkey_removed': ['Passkey removed', 'info'],
  'account.authenticator_added': ['Authenticator app added', 'info'],
  'account.authenticator_removed': ['Authenticator app removed', 'info'],
  'account.recovery_codes_created': ['Recovery codes created', 'info'],
  'account.sessions_revoked': ['Signed out other sessions', 'info'],
  'access_token.created': ['Access token created', 'info'],
  'access_token.revoked': ['Access token revoked', 'info'],
} as const satisfies Record<string, readonly [string, 'info' | 'warn']>

export type SecurityEvent = keyof typeof SECURITY_EVENTS

// actorId: who did it (null for the server itself); targetId: the account, organization or setting it was about
export function securityLog(event: SecurityEvent, fields: { actorId: string | null; targetId?: string | null } & Record<string, unknown>): void {
  const c = tryGetContext()
  const [msg, level] = SECURITY_EVENTS[event]
  log[level](msg, { event, ...fields, ip: c ? clientAddress(c) : null })
}
