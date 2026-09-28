import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import { CopyCommand } from '../components/CopyCommand'
import { timeAgo } from '../time'
import { createScimToken, getScim, revokeScimToken, type Organization, type ScimSettings } from './scimApi'

// Server admin: SCIM provisioning, an Enterprise feature of self-hosted installs. Rendered by
// pages/Admin.tsx on self-hosted installs only.

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'unlicensed' } | { kind: 'error' }
type Status = { tone: 'ok' | 'bad'; text: string; field?: string } | null

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)
const errorField = (err: unknown) => (err instanceof ApiError ? err.field : undefined)

function OrganizationSelect({
  id,
  value,
  onChange,
  organizations,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  organizations: Organization[]
}) {
  return (
    <select id={id} className="settings-select" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}>
      <option value="">No organization</option>
      {organizations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  )
}

export function ScimSection() {
  const [state, setState] = useState<Loadable<ScimSettings>>({ kind: 'loading' })
  const [name, setName] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [made, setMade] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>(null)

  useEffect(() => {
    let active = true
    getScim()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch((err) => {
        if (!active) return
        setState(err instanceof ApiError && err.code === 'enterprise_required' ? { kind: 'unlicensed' } : { kind: 'error' })
      })
    return () => {
      active = false
    }
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      const { token, ...data } = await createScimToken(name, organizationId)
      setState({ kind: 'ready', data })
      setMade(token)
      setName('')
    } catch (err) {
      setStatus({ tone: 'bad', text: errorText(err, 'The token could not be made. Try again.'), field: errorField(err) })
    }
    setBusy(false)
  }

  async function revoke(id: string) {
    setBusy(true)
    setStatus(null)
    try {
      setState({ kind: 'ready', data: await revokeScimToken(id) })
      setStatus({ tone: 'ok', text: 'Revoked. The IdP can’t use that token any more.' })
    } catch (err) {
      setStatus({ tone: 'bad', text: errorText(err, 'The token could not be revoked. Try again.') })
    }
    setBusy(false)
    setConfirming(null)
  }

  return (
    <section id="scim" className="settings-card" aria-labelledby="scim-title">
      <header className="settings-card-head">
        <h2 id="scim-title">
          Provisioning (SCIM) <span className="admin-badge">Enterprise</span>
        </h2>
        <p>
          Your identity provider creates accounts, keeps names and addresses current, and suspends people it deactivates.{' '}
          <Link className="text-link" to="/docs/scim">
            Setting up SCIM
          </Link>
        </p>
      </header>

      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading SCIM tokens
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          SCIM tokens could not be loaded. Reload to try again.
        </p>
      )}
      {state.kind === 'unlicensed' && (
        <p className="admin-source">
          SCIM needs an Enterprise license. Add a license key under{' '}
          <a className="text-link" href="#license">
            License
          </a>{' '}
          above, then make a token here.{' '}
          <Link className="text-link" to="/docs/scim#before-you-start">
            What you need
          </Link>
        </p>
      )}
      {state.kind === 'ready' && (
        <>
          <dl className="admin-facts">
            <div className="admin-facts-wide">
              <dt>SCIM base URL</dt>
              <dd>
                <CopyCommand command={state.data.baseUrl} label="Copy the SCIM base URL" plain />
              </dd>
            </div>
          </dl>

          {made && (
            <div className="admin-link-result">
              <p className="field-hint" role="status">
                Copy the token now and paste it into your IdP. It is not shown again.
              </p>
              <CopyCommand command={made} label="Copy the SCIM token" plain />
            </div>
          )}

          {state.data.tokens.length > 0 && (
            <ul className="settings-list" aria-label="SCIM tokens">
              {state.data.tokens.map((t) => (
                <li key={t.id} className="settings-row">
                  <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                    {t.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="settings-who">
                    <strong>{t.name}</strong>
                    <span>
                      {t.organizationName ? `New people join ${t.organizationName}` : 'New people start in a personal workspace'}, created{' '}
                      {timeAgo(t.createdAt)}
                    </span>
                    <span>{t.lastUsedAt ? `Last used ${timeAgo(t.lastUsedAt)}` : 'Not used yet'}</span>
                  </span>
                  <span className="settings-actions">
                    {confirming === t.id ? (
                      <>
                        <button type="button" className="button button-small button-danger" disabled={busy} onClick={() => void revoke(t.id)}>
                          Revoke
                        </button>
                        <button type="button" className="auth-reset" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="button button-small button-quiet" aria-label={`Revoke ${t.name}`} onClick={() => setConfirming(t.id)}>
                        Revoke
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <form className="admin-add-person" onSubmit={onCreate} noValidate>
            <div className="admin-add-form">
              <div className="field">
                <label htmlFor="scim-token-name">Token name</label>
                <input
                  id="scim-token-name"
                  className="admin-input"
                  value={name}
                  maxLength={60}
                  placeholder="Okta"
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={status?.field === 'name' || undefined}
                  aria-describedby={status?.field === 'name' ? 'scim-status' : undefined}
                />
              </div>
              <div className="field">
                <label htmlFor="scim-org">Organization for new people</label>
                <OrganizationSelect id="scim-org" value={organizationId} onChange={setOrganizationId} organizations={state.data.organizations} />
              </div>
              <button type="submit" className="button button-small" disabled={busy}>
                {busy ? 'Making' : 'Make token'}
              </button>
            </div>
            <p id="scim-org-hint" className="field-hint">
              Accounts the IdP creates join this organization as members. Deleting a user in the IdP suspends the account here.
            </p>
          </form>
          <p id="scim-status" className="field-hint" data-tone={status?.tone} aria-live="polite" role={status?.tone === 'bad' ? 'alert' : undefined}>
            {status?.text ?? ''}
          </p>
        </>
      )}
    </section>
  )
}
