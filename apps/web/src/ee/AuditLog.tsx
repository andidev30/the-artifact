import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import './AuditLog.css'

// An organization's audit log, an Enterprise feature of self-hosted installs. Organization settings
// loads this only for owners and admins on a self-hosted install. It shows nothing until the API
// answers, and nothing at all while the API says enterprise_required (no license that counts).

type AuditEvent = {
  id: string
  action: string
  at: string
  actor: { id: string | null; email: string | null } | null
  target: { type: string; id: string; label: string } | null
  details: Record<string, unknown>
  ip: string | null
  userAgent: string | null
}

type AuditPage = { events: AuditEvent[]; next: string | null; actions: string[]; retentionDays: number }

type Filters = { action: string; actor: string; from: string; to: string }

const NO_FILTERS: Filters = { action: '', actor: '', from: '', to: '' }

const ACTION_LABEL: Record<string, string> = {
  'sign_in.succeeded': 'Signed in',
  'sign_in.failed': 'Sign-in failed',
  'page.visibility_changed': 'Changed who can open a page',
  'page.link_changed': 'Changed a page’s link settings',
  'page.shared': 'Shared a page',
  'page.share_role_changed': 'Changed someone’s access to a page',
  'page.unshared': 'Removed someone from a page',
  'page.moved_in': 'Moved a page into the organization',
  'page.moved_out': 'Moved a page out of the organization',
  'page.deleted': 'Deleted a page',
  'member.invited': 'Invited someone',
  'member.invitation_revoked': 'Revoked an invitation',
  'member.joined': 'Joined',
  'member.added': 'Added someone',
  'member.role_changed': 'Changed a role',
  'member.removed': 'Removed a member',
  'member.left': 'Left',
  'member.suspended': 'Suspended',
  'member.reactivated': 'Reactivated',
  'organization.settings_changed': 'Changed settings',
  'organization.retention_changed': 'Changed version retention',
  'organization.export_requested': 'Started an export',
  'organization.export_downloaded': 'Downloaded an export',
  'agent.connected': 'Connected an agent',
  'agent.disconnected': 'Disconnected an agent',
  'access_token.created': 'Created an access token',
  'access_token.revoked': 'Revoked an access token',
  'webhook.created': 'Added a webhook',
  'webhook.changed': 'Changed a webhook',
  'webhook.deleted': 'Deleted a webhook',
}

const VISIBILITY_LABEL: Record<string, string> = { private: 'Restricted', organization: 'Organization', link: 'Anyone with the link' }
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', editor: 'Editor' }
const SETTING_LABEL: Record<string, string> = { name: 'Name', requireTwoFactor: 'Two-factor sign-in required' }
const DISCONNECT_LABEL: Record<string, string> = {
  settings: 'From their account settings',
  agent: 'The agent signed out',
  token_reused: 'Its refresh token was used twice, so the connection ended',
}
const RETENTION_LABEL: Record<string, string> = { keepDays: 'Days to keep', keepVersions: 'Versions to keep' }

const label = (map: Record<string, string>, v: unknown) => map[String(v)] ?? String(v)
const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))

function summary(e: AuditEvent): string {
  const d = e.details
  switch (e.action) {
    case 'sign_in.succeeded':
      return d.method ? `With ${d.method}` : d.secondFactor ? `Second step with ${d.secondFactor}` : ''
    case 'sign_in.failed':
      return d.reason ? `Reason: ${d.reason}` : ''
    case 'page.visibility_changed':
      return `${label(VISIBILITY_LABEL, d.from)} to ${label(VISIBILITY_LABEL, d.to)}`
    case 'page.link_changed': {
      const parts: string[] = []
      const expiry = d.expiresAt as { to: string | null } | undefined
      if (expiry) parts.push(expiry.to ? `Expires ${when.format(new Date(expiry.to))}` : 'No expiry')
      if (d.password === 'set') parts.push('Password set')
      if (d.password === 'removed') parts.push('Password removed')
      if (d.reset) parts.push('Link reset')
      return parts.join('; ')
    }
    case 'page.shared':
      return `With ${Array.isArray(d.people) ? d.people.join(', ') : ''} as ${label(ROLE_LABEL, d.role).toLowerCase()}`
    case 'page.share_role_changed':
      return `${d.person} is now ${label(ROLE_LABEL, d.role).toLowerCase()}`
    case 'page.unshared':
      return String(d.person ?? '')
    case 'page.moved_in':
      return d.from ? `From ${d.from}` : 'From the owner’s personal workspace'
    case 'page.moved_out': {
      const visibility = d.visibility as { from: unknown; to: unknown } | undefined
      const to = d.to ? `To ${d.to}` : 'To the owner’s personal workspace'
      return visibility ? `${to}; ${label(VISIBILITY_LABEL, visibility.from)} to ${label(VISIBILITY_LABEL, visibility.to)}` : to
    }
    case 'member.role_changed':
      return `${label(ROLE_LABEL, d.from)} to ${label(ROLE_LABEL, d.to)}`
    case 'member.invited':
    case 'member.invitation_revoked':
    case 'member.joined':
    case 'member.added':
    case 'member.removed':
    case 'member.left':
      return [d.role ? `As ${label(ROLE_LABEL, d.role).toLowerCase()}` : '', d.via ? `Through ${d.via}` : ''].filter(Boolean).join(', ')
    case 'member.suspended':
    case 'member.reactivated':
      return d.via ? `Through ${d.via}` : ''
    case 'organization.settings_changed':
      return Object.entries(d)
        .map(([k, v]) => {
          const change = v as { from: unknown; to: unknown }
          return `${label(SETTING_LABEL, k)}: ${show(change.from)} to ${show(change.to)}`
        })
        .join('; ')
    case 'organization.retention_changed':
      return Object.entries(d)
        .map(([k, v]) => {
          const change = v as { from: number | null; to: number | null }
          return `${label(RETENTION_LABEL, k)}: ${change.from ?? 'no limit'} to ${change.to ?? 'no limit'}`
        })
        .join('; ')
    case 'organization.export_requested':
    case 'organization.export_downloaded':
      return d.versions === 'all' ? 'Every version' : 'Current versions'
    case 'agent.disconnected':
      return d.via ? label(DISCONNECT_LABEL, d.via) : ''
    default:
      return ''
  }
}

const when = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

// Dates from the inputs are days in the viewer's own time zone; "to" takes in the whole day
function query(orgId: string, f: Filters, extra: Record<string, string> = {}) {
  const q = new URLSearchParams()
  if (f.action) q.set('action', f.action)
  if (f.actor.trim()) q.set('actor', f.actor.trim())
  if (f.from) q.set('from', new Date(`${f.from}T00:00:00`).toISOString())
  if (f.to) {
    const end = new Date(`${f.to}T00:00:00`)
    end.setDate(end.getDate() + 1)
    q.set('to', end.toISOString())
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v)
  return `/api/organizations/${encodeURIComponent(orgId)}/audit-log${extra.format ? '/export' : ''}?${q}`
}

async function load(url: string): Promise<AuditPage> {
  const res = await fetch(url, { credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'The audit log could not be loaded. Reload to try again.', res.status, data.code, data.field)
  return data
}

type State = { kind: 'loading' } | { kind: 'ready'; page: AuditPage } | { kind: 'error'; message: string } | { kind: 'unlicensed' }

export function AuditLogSection({ org, onAvailable }: { org: { id: string; name: string }; onAvailable: (on: boolean) => void }) {
  const [known, setKnown] = useState(false)
  const [draft, setDraft] = useState<Filters>(NO_FILTERS)
  const [applied, setApplied] = useState<Filters>(NO_FILTERS)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [more, setMore] = useState(false)
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let active = true
    setState({ kind: 'loading' })
    load(query(org.id, applied))
      .then((page) => {
        if (!active) return
        setState({ kind: 'ready', page })
        setKnown(true)
      })
      .catch((err) => {
        if (!active) return
        setKnown(true)
        if (err instanceof ApiError && err.code === 'enterprise_required') setState({ kind: 'unlicensed' })
        else if (err instanceof ApiError && err.field && err.field !== 'cursor') {
          setFieldError({ field: err.field, message: err.message })
          setState({ kind: 'ready', page: { events: [], next: null, actions: Object.keys(ACTION_LABEL), retentionDays: 365 } })
        } else setState({ kind: 'error', message: err instanceof Error ? err.message : 'The audit log could not be loaded. Reload to try again.' })
      })
    return () => {
      active = false
    }
  }, [org.id, applied])

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFieldError(null)
    if (draft.from && draft.to && draft.from > draft.to) {
      setFieldError({ field: 'to', message: 'Choose an end date on or after the start date.' })
      return
    }
    setApplied({ ...draft })
  }

  // Clear goes away with the filters, so focus moves to the first of them instead of the page
  function clear() {
    setFieldError(null)
    setDraft(NO_FILTERS)
    setApplied(NO_FILTERS)
    document.getElementById('audit-action')?.focus()
  }

  async function loadMore() {
    if (state.kind !== 'ready' || !state.page.next) return
    setMore(true)
    const shown = state.page.events.length
    try {
      const next = await load(query(org.id, applied, { cursor: state.page.next }))
      setState({ kind: 'ready', page: { ...next, events: [...state.page.events, ...next.events] } })
      // Keyboard users land on the first new event instead of back at the top
      requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>('.audit-event')[shown]?.focus())
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'More events could not be loaded. Try again.' })
    }
    setMore(false)
  }

  const unlicensed = state.kind === 'unlicensed'
  useEffect(() => {
    if (known) onAvailable(!unlicensed)
  }, [known, unlicensed, onAvailable])

  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTERS)
  const hint = (field: string) => (fieldError?.field === field ? fieldError.message : null)

  if (!known || unlicensed) return null

  const retention = state.kind === 'ready' ? state.page.retentionDays : null
  return (
    <section id="audit" className="settings-card" aria-labelledby="audit-title">
      <header className="settings-card-head">
        <h2 id="audit-title">Audit log</h2>
        <p>
          Who signed in, shared pages, changed members or settings, and made access tokens in {org.name}, newest first.
          {retention ? ` Events are kept for ${retention === 365 ? 'a year' : `${retention} days`}.` : ''}{' '}
          <Link className="text-link" to="/docs/audit-log">
            What is recorded
          </Link>
        </p>
      </header>

      <form className="audit-filters" onSubmit={onSubmit} aria-label="Filter the audit log">
        <div className="field">
          <label htmlFor="audit-action">Action</label>
          <select id="audit-action" className="settings-select" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABEL).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-actor">Person</label>
          <input
            id="audit-actor"
            type="search"
            value={draft.actor}
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
            placeholder="name@company.com"
            autoComplete="off"
            maxLength={254}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            aria-invalid={hint('from') ? true : undefined}
            aria-describedby={hint('from') ? 'audit-filter-error' : undefined}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            aria-invalid={hint('to') ? true : undefined}
            aria-describedby={hint('to') ? 'audit-filter-error' : undefined}
          />
        </div>
        <div className="audit-filter-actions">
          <button type="submit" className="button button-small">
            Filter
          </button>
          {filtered && (
            <button type="button" className="auth-reset" onClick={clear}>
              Clear
            </button>
          )}
        </div>
        <p id="audit-filter-error" className="field-hint audit-filter-hint" data-tone={fieldError ? 'bad' : undefined} aria-live="polite">
          {fieldError?.message ?? ''}
        </p>
      </form>

      <div className="audit-export">
        <span className="settings-label">Export {filtered ? 'these events' : 'every event'}</span>
        <a className="button button-small button-quiet" href={query(org.id, applied, { format: 'csv' })} download>
          CSV
        </a>
        <a className="button button-small button-quiet" href={query(org.id, applied, { format: 'json' })} download>
          JSON
        </a>
      </div>

      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading the audit log
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && state.page.events.length === 0 && (
        <p className="settings-muted" role="status">
          {filtered ? 'No events match these filters.' : 'Nothing has been recorded yet.'}
        </p>
      )}
      {state.kind === 'ready' && state.page.events.length > 0 && (
        <>
          <ul className="settings-list" aria-label="Audit log events" ref={list}>
            {state.page.events.map((e) => {
              const detail = summary(e)
              return (
                <li key={e.id} className="settings-row audit-event" tabIndex={-1}>
                  <span className="settings-who">
                    <strong>
                      {ACTION_LABEL[e.action] ?? e.action}
                      {e.target && e.target.type !== 'member' && e.target.type !== 'organization' ? `: ${e.target.label}` : ''}
                    </strong>
                    <span>
                      {e.actor?.email ?? 'Someone whose account is gone'}
                      {e.target?.type === 'member' && e.target.label !== e.actor?.email ? `, about ${e.target.label}` : ''}
                    </span>
                    {detail && <span>{detail}</span>}
                  </span>
                  <span className="settings-meta audit-meta">
                    <time dateTime={e.at}>{when.format(new Date(e.at))}</time>
                    {e.ip && <span title={e.userAgent ?? undefined}>{e.ip}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
          {state.page.next && (
            <button type="button" className="button button-small button-quiet audit-more" onClick={loadMore} disabled={more}>
              {more ? 'Loading' : 'Show more'}
            </button>
          )}
        </>
      )}
    </section>
  )
}
