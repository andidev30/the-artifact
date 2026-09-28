import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import './Retention.css'

// Version retention, an enterprise feature (apps/api/src/ee/retention.ts): owners and admins choose
// how long older versions of an organization's pages are kept. OrganizationSettings shows it to them
// on a self-hosted install.

type LicenseStatus = 'none' | 'active' | 'grace' | 'expired'
type Policy = { keepDays: number | null; keepVersions: number | null }
type Retention = Policy & { updatedAt: string | null; license: LicenseStatus; applied: boolean }
type Preview = { versions: number; pages: number }

const DAY_OPTIONS: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 180, label: '180 days' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
  { days: null, label: 'Forever' },
]

async function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method,
    credentials: 'same-origin',
    headers: init?.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong. Try again.', res.status, data?.code, data?.field)
  return data as T
}

const path = (orgId: string) => `/organizations/${encodeURIComponent(orgId)}/retention`

function previewQuery(p: Policy) {
  const q = new URLSearchParams()
  if (p.keepDays !== null) q.set('keepDays', String(p.keepDays))
  if (p.keepVersions !== null) q.set('keepVersions', String(p.keepVersions))
  return q.toString()
}

const licensed = (s: LicenseStatus) => s === 'active' || s === 'grace'
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function describe(p: Policy): string {
  const days = p.keepDays === null ? null : (DAY_OPTIONS.find((o) => o.days === p.keepDays)?.label ?? plural(p.keepDays, 'day', 'days'))
  if (days && p.keepVersions) return `Older versions are kept for ${days}, and at most ${plural(p.keepVersions, 'version', 'versions')} per page.`
  if (days) return `Older versions are kept for ${days}.`
  if (p.keepVersions) return `At most ${plural(p.keepVersions, 'version', 'versions')} are kept per page.`
  return 'Every version is kept.'
}

export function RetentionSection({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Retention }>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    request<Retention>(path(orgId))
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [orgId])

  return (
    <section id="retention" className="settings-card" aria-labelledby="retention-title">
      <header className="settings-card-head">
        <h2 id="retention-title">
          Version history <span className="retention-badge">Enterprise</span>
        </h2>
        <p>
          How long older versions of {orgName}’s pages are kept. The current version of a page is always kept, and pages are never deleted.{' '}
          <Link className="text-link" to="/docs/retention">
            How retention works
          </Link>
        </p>
      </header>
      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading version history settings
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          The version history settings could not be loaded. Reload to try again.
        </p>
      )}
      {state.kind === 'ready' && <RetentionForm orgId={orgId} saved={state.data} onSaved={(data) => setState({ kind: 'ready', data })} />}
    </section>
  )
}

function RetentionForm({ orgId, saved, onSaved }: { orgId: string; saved: Retention; onSaved: (r: Retention) => void }) {
  const id = useId()
  const [keepDays, setKeepDays] = useState<number | null>(saved.keepDays)
  const [limitCount, setLimitCount] = useState(saved.keepVersions !== null)
  const [count, setCount] = useState(String(saved.keepVersions ?? 20))
  const [preview, setPreview] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; data: Preview } | { kind: 'error'; text: string }>({
    kind: 'idle',
  })
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string; field?: string } | null>(null)
  const nowRef = useRef<HTMLParagraphElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)

  // The confirm step swaps the buttons, so focus follows it there and back
  useEffect(() => {
    if (confirming) {
      asked.current = true
      confirmRef.current?.focus()
    } else if (asked.current) {
      asked.current = false
      if (document.activeElement === document.body) saveRef.current?.focus()
    }
  }, [confirming])

  const on = licensed(saved.license)
  const countValue = Number(count)
  const countValid = !limitCount || (Number.isInteger(countValue) && countValue >= 1 && countValue <= 10_000)
  const keepVersions = limitCount && countValid ? countValue : null
  const policy: Policy = { keepDays, keepVersions }
  const changed = policy.keepDays !== saved.keepDays || policy.keepVersions !== saved.keepVersions
  const empty = policy.keepDays === null && policy.keepVersions === null
  const dayOptions = DAY_OPTIONS.some((o) => o.days === saved.keepDays)
    ? DAY_OPTIONS
    : [{ days: saved.keepDays, label: plural(saved.keepDays ?? 0, 'day', 'days') }, ...DAY_OPTIONS]

  // What the chosen policy would remove, fetched a moment after the last change
  useEffect(() => {
    setConfirming(false)
    if (!on || !countValid || empty) {
      setPreview({ kind: 'idle' })
      return
    }
    let active = true
    setPreview({ kind: 'loading' })
    const timer = setTimeout(() => {
      request<Preview>(`${path(orgId)}/preview?${previewQuery({ keepDays, keepVersions })}`)
        .then((data) => active && setPreview({ kind: 'ready', data }))
        .catch((err) => active && setPreview({ kind: 'error', text: err instanceof Error ? err.message : 'The count could not be worked out.' }))
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [orgId, on, countValid, empty, keepDays, keepVersions])

  const removes = preview.kind === 'ready' ? preview.data.versions : 0

  async function save(e?: FormEvent) {
    e?.preventDefault()
    if (!countValid) {
      setStatus({ tone: 'bad', text: 'Keep 1 to 10,000 versions per page.', field: 'keepVersions' })
      return
    }
    // Removing versions can't be undone, so that takes a second, explicit step
    if (removes > 0 && !confirming) {
      setConfirming(true)
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      const data = await request<Retention>(path(orgId), { method: 'PUT', json: policy })
      asked.current = false
      setConfirming(false)
      setSaving(false)
      onSaved(data)
      setStatus({ tone: 'ok', text: 'Saved.' })
      // The button just used is now disabled; the updated summary is the next thing to read
      nowRef.current?.focus()
    } catch (err) {
      setStatus({
        tone: 'bad',
        text: err instanceof Error ? err.message : 'The setting could not be saved. Try again.',
        field: err instanceof ApiError ? err.field : undefined,
      })
      setSaving(false)
      setConfirming(false)
    }
  }

  return (
    <form className="settings-form retention-form" onSubmit={save} aria-describedby={`${id}-now`}>
      <p id={`${id}-now`} ref={nowRef} tabIndex={-1} className="settings-value retention-now">
        Now: {describe(saved)}
      </p>

      {!on && (
        <p className="retention-license" role="note">
          {saved.keepDays !== null || saved.keepVersions !== null
            ? 'This install has no Enterprise license that counts, so this policy is kept but not applied: no versions are removed.'
            : 'Version retention needs an Enterprise license.'}{' '}
          {saved.license === 'expired' ? 'The license has expired. ' : ''}An instance admin can add a license key under Server admin.
        </p>
      )}
      {on && saved.license === 'grace' && (
        <p className="retention-license" role="note">
          The Enterprise license has expired and is in its grace period. Retention stops when the grace period ends; the policy is kept.
        </p>
      )}

      <div className="field">
        <label htmlFor={`${id}-days`}>Keep older versions for</label>
        <select
          id={`${id}-days`}
          className="settings-select retention-select"
          value={keepDays === null ? '' : String(keepDays)}
          disabled={!on || saving}
          aria-invalid={status?.field === 'keepDays' || undefined}
          aria-describedby={status?.field === 'keepDays' ? `${id}-status` : undefined}
          onChange={(e) => {
            setKeepDays(e.target.value === '' ? null : Number(e.target.value))
            setStatus(null)
          }}
        >
          {dayOptions.map((o) => (
            <option key={o.label} value={o.days === null ? '' : String(o.days)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={limitCount}
            disabled={!on || saving}
            onChange={(e) => {
              setLimitCount(e.target.checked)
              setStatus(null)
            }}
          />
          <span>Also keep at most a number of versions per page</span>
        </label>
        {limitCount && (
          <div className="retention-count">
            <label htmlFor={`${id}-count`}>Versions per page, the current one included</label>
            <input
              id={`${id}-count`}
              type="number"
              inputMode="numeric"
              min={1}
              max={10000}
              step={1}
              value={count}
              disabled={!on || saving}
              aria-invalid={!countValid || status?.field === 'keepVersions' || undefined}
              aria-describedby={`${id}-count-hint`}
              onChange={(e) => {
                setCount(e.target.value)
                setStatus(null)
              }}
            />
            <p id={`${id}-count-hint`} className="field-hint" data-tone={countValid ? undefined : 'bad'}>
              {countValid ? 'Older versions beyond this number are removed, whatever their age.' : 'Use a whole number from 1 to 10,000.'}
            </p>
          </div>
        )}
      </div>

      {on && !empty && (
        <div className="retention-warning" role="note">
          <strong>Removed versions can’t be restored.</strong> Versions outside this policy are deleted for good, together with their files, a few hours after
          you save and every few hours after that.
        </div>
      )}

      <p className="field-hint retention-preview" aria-live="polite">
        {!on || empty || !changed
          ? ''
          : preview.kind === 'loading'
            ? 'Counting the versions this would remove'
            : preview.kind === 'error'
              ? preview.text
              : preview.kind === 'ready'
                ? preview.data.versions === 0
                  ? 'No versions would be removed right now.'
                  : `About ${plural(preview.data.versions, 'version', 'versions')} on ${plural(preview.data.pages, 'page', 'pages')} would be removed.`
                : ''}
      </p>

      <div className="retention-actions">
        {confirming ? (
          <>
            <button ref={confirmRef} type="submit" className="button button-small button-danger" disabled={saving}>
              {saving ? 'Saving' : `Save and remove ${plural(removes, 'version', 'versions')}`}
            </button>
            <button type="button" className="auth-reset" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            ref={saveRef}
            type="submit"
            className="button button-small"
            disabled={saving || !changed || !countValid || (!on && !empty) || preview.kind === 'loading'}
          >
            {saving ? 'Saving' : empty && changed ? 'Turn off retention' : 'Save'}
          </button>
        )}
        {!on && !(saved.keepDays === null && saved.keepVersions === null) && !changed && (
          <button
            type="button"
            className="button button-small button-quiet"
            disabled={saving}
            onClick={() => {
              setKeepDays(null)
              setLimitCount(false)
            }}
          >
            Clear policy
          </button>
        )}
      </div>
      <p id={`${id}-status`} className="field-hint" data-tone={status?.tone} aria-live="polite">
        {status?.text ?? ''}
      </p>
    </form>
  )
}
