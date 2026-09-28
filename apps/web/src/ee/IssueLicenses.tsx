import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { adminRequest } from '../adminApi'
import { CopyCommand } from '../components/CopyCommand'
import './IssueLicenses.css'

// Server admin on the hosted service: issuing license keys for self-hosted installs

type IssuedLicense = {
  id: string
  customerName: string
  customerEmail: string
  seats: number
  issuedAt: string
  expiresAt: string
  issuedBy: string | null
}

type Issued = { available: boolean; reason: string | null; licenses: IssuedLicense[] }

type Form = { customerName: string; customerEmail: string; seats: string; expiresOn: string }

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en', { dateStyle: 'long', timeZone: 'UTC' })

function inAYear() {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

const EMPTY: Form = { customerName: '', customerEmail: '', seats: '', expiresOn: '' }

export function IssuedLicensesSection() {
  const [data, setData] = useState<{ kind: 'loading' } | { kind: 'ready'; data: Issued } | { kind: 'error' }>({ kind: 'loading' })
  const [form, setForm] = useState<Form>(() => ({ ...EMPTY, expiresOn: inAYear() }))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ text: string; field?: string } | null>(null)
  const [made, setMade] = useState<{ key: string; license: IssuedLicense } | null>(null)
  const result = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    fetchIssued()
      .then((d) => active && setData({ kind: 'ready', data: d }))
      .catch(() => active && setData({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (made) result.current?.focus()
  }, [made])

  function set(field: keyof Form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setProblem(null)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      const res = await issue({ ...form, seats: Number(form.seats) })
      setMade(res)
      setForm({ ...EMPTY, expiresOn: inAYear() })
      setData((d) => (d.kind === 'ready' ? { kind: 'ready', data: { ...d.data, licenses: [res.license, ...d.data.licenses] } } : d))
    } catch (err) {
      const field = err instanceof Error && 'field' in err ? (err.field as string | undefined) : undefined
      setProblem({ text: err instanceof Error ? err.message : 'The key could not be issued. Try again.', field })
    }
    setBusy(false)
  }

  const describedBy = (field: keyof Form, hint?: string) => [hint, problem?.field === field ? 'issue-error' : null].filter(Boolean).join(' ') || undefined

  return (
    <section id="license-keys" className="settings-card" aria-labelledby="license-keys-title">
      <header className="settings-card-head">
        <h2 id="license-keys-title">License keys</h2>
        <p>
          Issue keys for customers who run their own server. Their server checks the key offline.{' '}
          <Link className="text-link" to="/docs/licenses">
            About licenses
          </Link>
        </p>
      </header>

      {data.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading license keys
        </p>
      )}
      {data.kind === 'error' && (
        <p className="auth-notice" role="alert">
          License keys could not be loaded. Reload to try again.
        </p>
      )}

      {data.kind === 'ready' && !data.data.available && (
        <p className="admin-source" role="note">
          You can’t issue keys yet. {data.data.reason}
        </p>
      )}

      {data.kind === 'ready' && data.data.available && (
        <form className="settings-form issue-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="issue-name">Customer</label>
            <input
              id="issue-name"
              className="admin-input"
              value={form.customerName}
              onChange={(e) => set('customerName', e.target.value)}
              placeholder="Acme Inc"
              autoComplete="off"
              aria-invalid={problem?.field === 'customerName' || undefined}
              aria-describedby={describedBy('customerName')}
            />
          </div>
          <div className="field">
            <label htmlFor="issue-email">Customer email</label>
            <input
              id="issue-email"
              className="admin-input"
              type="email"
              value={form.customerEmail}
              onChange={(e) => set('customerEmail', e.target.value)}
              placeholder="it@acme.example"
              autoComplete="off"
              aria-invalid={problem?.field === 'customerEmail' || undefined}
              aria-describedby={describedBy('customerEmail')}
            />
          </div>
          <div className="field">
            <label htmlFor="issue-seats">Seats</label>
            <input
              id="issue-seats"
              className="admin-input"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={form.seats}
              onChange={(e) => set('seats', e.target.value)}
              aria-invalid={problem?.field === 'seats' || undefined}
              aria-describedby={describedBy('seats', 'issue-seats-hint')}
            />
            <p id="issue-seats-hint" className="field-hint">
              Accounts that aren’t suspended. Going over shows a warning; nobody is locked out.
            </p>
          </div>
          <div className="field">
            <label htmlFor="issue-expires">Last valid day</label>
            <input
              id="issue-expires"
              className="admin-input"
              type="date"
              value={form.expiresOn}
              onChange={(e) => set('expiresOn', e.target.value)}
              aria-invalid={problem?.field === 'expiresOn' || undefined}
              aria-describedby={describedBy('expiresOn', 'issue-expires-hint')}
            />
            <p id="issue-expires-hint" className="field-hint">
              Valid through the end of this day (UTC), then 14 days of grace.
            </p>
          </div>
          <div className="admin-panel-actions">
            <button type="submit" className="button button-small" disabled={busy}>
              {busy ? 'Issuing' : 'Issue key'}
            </button>
          </div>
          {problem && (
            <p id="issue-error" className="auth-notice" role="alert">
              {problem.text}
            </p>
          )}
        </form>
      )}

      {made && (
        <div ref={result} className="admin-link-result issue-result" role="status" tabIndex={-1}>
          <p className="field-hint">Send this key to {made.license.customerEmail}. It is shown only once; it isn’t stored here.</p>
          <CopyCommand command={made.key} label="Copy license key" plain />
        </div>
      )}

      {data.kind === 'ready' && data.data.licenses.length > 0 && (
        <div className="issue-list">
          <h3 className="settings-label">Issued</h3>
          <ul className="settings-list">
            {data.data.licenses.map((l) => (
              <li key={l.id} className="issue-row">
                <strong>{l.customerName}</strong>
                <span>{l.customerEmail}</span>
                <span>
                  {l.seats.toLocaleString('en')} {l.seats === 1 ? 'seat' : 'seats'}, valid until {longDate(l.expiresAt)}
                </span>
                <span className="settings-muted">
                  Issued {longDate(l.issuedAt)}
                  {l.issuedBy ? ` by ${l.issuedBy}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const fetchIssued = () => adminRequest<Issued>('/issued-licenses')

const issue = (body: Omit<Form, 'seats'> & { seats: number }) =>
  adminRequest<{ key: string; license: IssuedLicense }>('/issued-licenses', { method: 'POST', json: body })
