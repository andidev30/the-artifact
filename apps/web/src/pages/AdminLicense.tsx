import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { getLicense, removeLicense, saveLicense, type LicenseState } from '../adminApi'

// Server admin on a self-hosted install: the license key that turns on enterprise features

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en', { dateStyle: 'long', timeZone: 'UTC' })
const count = (n: number) => n.toLocaleString('en')

type Loadable = { kind: 'loading' } | { kind: 'ready'; data: LicenseState } | { kind: 'error' }

const STATUS_LABEL = { none: 'None', active: 'Active', grace: 'Expired, in grace period', expired: 'Expired' }

export function LicenseSection() {
  const [state, setState] = useState<Loadable>({ kind: 'loading' })
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const removeButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const keyField = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let active = true
    getLicense()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
  }, [confirming])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      setState({ kind: 'ready', data: await saveLicense(key) })
      setKey('')
      setStatus({ tone: 'ok', text: 'Saved. Enterprise features are on.' })
      // The Save button turns disabled with the field empty, which would leave keyboard focus nowhere
      keyField.current?.focus()
    } catch (err) {
      setStatus({ tone: 'bad', text: err instanceof Error ? err.message : 'The key could not be saved. Try again.' })
    }
    setBusy(false)
  }

  async function onRemove() {
    setBusy(true)
    setStatus(null)
    try {
      setState({ kind: 'ready', data: await removeLicense() })
      setConfirming(false)
      setStatus({ tone: 'ok', text: 'Removed. Enterprise features are off.' })
      keyField.current?.focus()
    } catch (err) {
      setStatus({ tone: 'bad', text: err instanceof Error ? err.message : 'The key could not be removed. Try again.' })
    }
    setBusy(false)
  }

  function cancelRemove() {
    setConfirming(false)
    // The button is back once the confirmation closes
    requestAnimationFrame(() => removeButton.current?.focus())
  }

  const data = state.kind === 'ready' ? state.data : null
  const l = data?.license ?? null
  const hasKey = Boolean(l)
  const bad = status?.tone === 'bad'

  return (
    <section id="license" className="settings-card" aria-labelledby="license-title">
      <header className="settings-card-head">
        <h2 id="license-title">License</h2>
        <p>
          An Enterprise license key turns on enterprise features on this server. This server checks the key itself and sends nothing anywhere.{' '}
          <Link className="text-link" to="/docs/licenses">
            About licenses
          </Link>
        </p>
      </header>

      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading the license
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          The license could not be loaded. Reload to try again.
        </p>
      )}

      {data && (
        <div className="settings-form">
          {data.invalid && (
            <p className="auth-notice" role="alert">
              The saved key doesn’t work: {data.invalid} Enterprise features are off.
            </p>
          )}

          {l && data.status === 'grace' && (
            <p className="admin-source" role="alert">
              This license expired on {longDate(l.expiresAt)}. Enterprise features stay on until {longDate(l.graceEndsAt)}. Enter a new key before then.
            </p>
          )}
          {l && data.status === 'expired' && (
            <p className="auth-notice" role="alert">
              This license expired on {longDate(l.expiresAt)}, and enterprise features are off. Pages and everything else keep working. Enter a new key to turn
              them back on.
            </p>
          )}
          {l && data.seatsInUse > l.seats && (
            <p className="admin-source" role="note">
              {count(data.seatsInUse)} people have an account, more than the {count(l.seats)} seats of this license. Nobody is locked out. Ask for a license
              with more seats.
            </p>
          )}

          {l ? (
            <dl className="admin-facts">
              <div>
                <dt>Licensed to</dt>
                <dd>{l.customer}</dd>
              </div>
              <div>
                <dt>Contact</dt>
                <dd>{l.email}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{STATUS_LABEL[data.status]}</dd>
              </div>
              <div>
                <dt>Valid until</dt>
                <dd>{longDate(l.expiresAt)}</dd>
              </div>
              <div>
                <dt>Seats</dt>
                <dd>
                  {count(data.seatsInUse)} of {count(l.seats)} in use
                </dd>
              </div>
              <div>
                <dt>Issued</dt>
                <dd>{longDate(l.issuedAt)}</dd>
              </div>
            </dl>
          ) : (
            !data.invalid && <p className="settings-muted">No license key. Enterprise features are off; everything else works without one.</p>
          )}

          <form className="settings-form" onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="license-key">{hasKey || data.invalid ? 'New license key' : 'License key'}</label>
              <textarea
                ref={keyField}
                id="license-key"
                className="admin-textarea"
                rows={4}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  setStatus(null)
                }}
                placeholder="art_lic_…"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={bad || undefined}
                aria-describedby={bad ? 'license-key-hint license-status' : 'license-key-hint'}
              />
              <p id="license-key-hint" className="field-hint">
                Paste the whole key from your license email. {hasKey ? 'It replaces the current key.' : ''}
              </p>
            </div>
            <div className="admin-panel-actions">
              <button type="submit" className="button button-small" disabled={busy || !key.trim()}>
                {busy && !confirming ? 'Saving' : hasKey ? 'Replace key' : 'Save key'}
              </button>
              {(hasKey || data.invalid) && !confirming && (
                <button ref={removeButton} type="button" className="auth-reset admin-delete-link" onClick={() => setConfirming(true)} disabled={busy}>
                  Remove key
                </button>
              )}
            </div>
          </form>

          {confirming && (
            <div className="admin-confirm" role="group" aria-label="Confirm: Remove key">
              <p>Enterprise features turn off. Nothing is deleted, and pages keep working.</p>
              <div className="admin-panel-actions">
                <button ref={confirmButton} type="button" className="button button-small button-danger" disabled={busy} onClick={onRemove}>
                  {busy ? 'Working' : 'Remove key'}
                </button>
                <button type="button" className="auth-reset" onClick={cancelRemove}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <p id="license-status" className="field-hint" data-tone={status?.tone} aria-live="polite" role={bad ? 'alert' : undefined}>
            {status?.text ?? ''}
          </p>
        </div>
      )}
    </section>
  )
}
