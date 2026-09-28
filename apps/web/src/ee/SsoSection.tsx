import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api'
import { CopyCommand } from '../components/CopyCommand'
import {
  createSso,
  deleteSso,
  listSso,
  ssoTestResult,
  ssoTestUrl,
  updateSso,
  type SsoConnection,
  type SsoInput,
  type SsoListing,
  type SsoTestResult,
} from './ssoApi'
import './Sso.css'

// Server admin: single sign-on through an OpenID Connect or SAML provider, an Enterprise feature of
// self-hosted installs. Rendered by pages/Admin.tsx on self-hosted installs only.

type State = { kind: 'loading' } | { kind: 'ready'; data: SsoListing } | { kind: 'unlicensed'; message: string } | { kind: 'error' }

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const editId = (id: string) => `sso-edit-${id}`
const ADD_ID = 'sso-add'

export function SsoSection() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [test, setTest] = useState<SsoTestResult | null>(null)
  const testResult = useRef<Promise<SsoTestResult | null> | null>(null)
  // After a panel closes, focus goes back to the button that opened it, once it has rendered again
  const [focusTo, focusSoon] = useState<string | null>(null)

  useEffect(() => {
    if (!focusTo) return
    document.getElementById(focusTo)?.focus()
    focusSoon(null)
  }, [focusTo])

  useEffect(() => {
    let active = true
    listSso()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch((err) => {
        if (!active) return
        if (err instanceof ApiError && err.code === 'enterprise_required') setState({ kind: 'unlicensed', message: err.message })
        else setState({ kind: 'error' })
      })
    // Back from "Test connection": the result waits on the server and can be read once, so the
    // request is kept in a ref that outlives the effect running twice in development
    const params = new URLSearchParams(window.location.search)
    if (params.has('sso-test')) {
      params.delete('sso-test')
      const rest = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}#sso`)
      testResult.current ??= ssoTestResult().catch(() => null)
    }
    testResult.current?.then((r) => active && r && setTest(r))
    return () => {
      active = false
    }
  }, [])

  function saved(conn: SsoConnection) {
    setState((s) => {
      if (s.kind !== 'ready') return s
      const exists = s.data.connections.some((c) => c.id === conn.id)
      const connections = exists ? s.data.connections.map((c) => (c.id === conn.id ? conn : c)) : [...s.data.connections, conn]
      return { kind: 'ready', data: { ...s.data, connections } }
    })
    focusSoon(editing === conn.id ? editId(conn.id) : ADD_ID)
    setEditing(null)
  }

  function closeForm() {
    focusSoon(editing && editing !== 'new' ? editId(editing) : ADD_ID)
    setEditing(null)
  }

  function removed(id: string) {
    setState((s) => (s.kind === 'ready' ? { kind: 'ready', data: { ...s.data, connections: s.data.connections.filter((c) => c.id !== id) } } : s))
    setRemoving(null)
    focusSoon(ADD_ID)
  }

  const data = state.kind === 'ready' ? state.data : null
  const tested = data?.connections.find((c) => c.id === test?.connectionId)

  return (
    <section id="sso" className="settings-card" aria-labelledby="sso-title">
      <header className="settings-card-head">
        <h2 id="sso-title">
          Single sign-on <span className="admin-badge">Enterprise</span>
        </h2>
        <p>
          People sign in through your identity provider with OpenID Connect or SAML: Google Workspace, Microsoft Entra ID, Okta, Keycloak and others.{' '}
          <Link className="text-link" to="/docs/sso">
            How to set it up
          </Link>{' '}
          <Link className="text-link" to="/docs/saml">
            SAML
          </Link>
        </p>
      </header>

      {test && <TestResult result={test} name={tested?.name} onClose={() => setTest(null)} />}

      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading single sign-on
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          Single sign-on could not be loaded. Reload to try again.
        </p>
      )}
      {state.kind === 'unlicensed' && (
        <p className="admin-source">
          Single sign-on needs an Enterprise license. Add a license key under{' '}
          <a className="text-link" href="#license">
            License
          </a>{' '}
          above, then add your identity provider here.{' '}
          <Link className="text-link" to="/docs/sso#the-license">
            About the license
          </Link>
        </p>
      )}

      {data && (
        <>
          <div className="field">
            <span className="settings-label">Redirect URI</span>
            <CopyCommand command={data.redirectUri} plain label="Copy the redirect URI" />
            <p className="field-hint">Register this address with your provider as the redirect (callback) URI of the app.</p>
          </div>
          <div className="field">
            <span className="settings-label">SAML entity ID and ACS URL</span>
            <CopyCommand command={data.saml.entityId} plain label="Copy the SAML entity ID" />
            <CopyCommand command={data.saml.acsUrl} plain label="Copy the SAML ACS URL" />
            <p className="field-hint">For a SAML app: the entity ID (audience URI) and the ACS (single sign-on) URL to enter at your IdP.</p>
          </div>

          {data.connections.length > 0 && (
            <ul className="settings-list">
              {data.connections.map((c) => (
                <li key={c.id} className="settings-row admin-row" data-open={editing === c.id || removing === c.id || undefined}>
                  <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                    {c.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="settings-who">
                    <strong>
                      <span className="admin-name">{c.name}</span>
                      {!c.enabled && <span className="admin-badge">Off</span>}
                      {c.enabled && c.required && <span className="admin-badge">Required</span>}
                    </strong>
                    <span className="sso-issuer">{c.protocol === 'saml' ? `SAML, ${c.saml?.idpEntityId ?? ''}` : c.issuer}</span>
                  </span>
                  <span className="settings-meta">{c.allowedDomains.length ? c.allowedDomains.join(', ') : 'Any address'}</span>
                  <span className="settings-actions sso-actions">
                    {c.protocol === 'oidc' && (
                      <a className="button button-small button-quiet" href={ssoTestUrl(c.id)} aria-label={`Test connection ${c.name}`}>
                        Test connection
                      </a>
                    )}
                    <button
                      type="button"
                      id={editId(c.id)}
                      className="button button-small button-quiet"
                      aria-label={`${editing === c.id ? 'Close' : 'Edit'} ${c.name}`}
                      aria-expanded={editing === c.id}
                      onClick={() => {
                        setRemoving(null)
                        setEditing(editing === c.id ? null : c.id)
                      }}
                    >
                      {editing === c.id ? 'Close' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      id={`sso-remove-${c.id}`}
                      className="button button-small button-quiet"
                      aria-label={`${removing === c.id ? 'Cancel removing' : 'Remove'} ${c.name}`}
                      aria-expanded={removing === c.id}
                      onClick={() => {
                        setEditing(null)
                        setRemoving(removing === c.id ? null : c.id)
                      }}
                    >
                      {removing === c.id ? 'Cancel' : 'Remove'}
                    </button>
                  </span>
                  {editing === c.id && (
                    <div className="admin-panel">
                      <SsoForm connection={c} organizations={data.organizations} onSaved={saved} onCancel={closeForm} />
                    </div>
                  )}
                  {removing === c.id && (
                    <RemoveConnection
                      connection={c}
                      onRemoved={() => removed(c.id)}
                      onCancel={() => {
                        setRemoving(null)
                        focusSoon(`sso-remove-${c.id}`)
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {editing === 'new' ? (
            <div className="admin-panel">
              <SsoForm organizations={data.organizations} onSaved={saved} onCancel={closeForm} />
            </div>
          ) : (
            <div>
              <button
                type="button"
                id={ADD_ID}
                className="button button-small"
                onClick={() => {
                  setRemoving(null)
                  setEditing('new')
                }}
              >
                Add a provider
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function TestResult({ result, name, onClose }: { result: SsoTestResult; name?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const who = name ?? 'The provider'
  return (
    <div ref={ref} className="sso-test" data-tone={result.ok && result.accepted ? 'ok' : 'bad'} role="status" tabIndex={-1} aria-labelledby="sso-test-title">
      <strong id="sso-test-title">
        {result.ok ? `${who} signed in ${result.email ?? 'someone without an email address'}` : `${who} could not sign you in`}
      </strong>
      {result.ok ? (
        <dl className="admin-facts">
          <dt>Email verified</dt>
          <dd>{result.emailVerified ? 'Yes' : 'No'}</dd>
          <dt>Subject</dt>
          <dd className="sso-mono">{result.subject}</dd>
          <dt>Name</dt>
          <dd>{result.name ?? 'Not sent'}</dd>
          <dt>Would get in</dt>
          <dd>
            {result.accepted
              ? 'Yes. Nobody was signed in by this test.'
              : 'No: the address is missing, not verified, or not at one of the connection’s domains. Nobody was signed in by this test.'}
          </dd>
        </dl>
      ) : (
        <p className="sso-mono">{result.error}</p>
      )}
      <div>
        <button type="button" className="auth-reset" onClick={onClose}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function RemoveConnection({ connection, onRemoved, onCancel }: { connection: SsoConnection; onRemoved: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirm.current?.focus()
  }, [])

  async function remove() {
    setBusy(true)
    setProblem(null)
    try {
      await deleteSso(connection.id)
      onRemoved()
    } catch (err) {
      setProblem(errorText(err, 'The connection could not be removed. Try again.'))
      setBusy(false)
    }
  }

  return (
    <div className="admin-confirm admin-panel" role="group" aria-label={`Confirm: remove ${connection.name}`}>
      <p>
        Remove <strong>{connection.name}</strong>? Its button leaves the sign-in page. People keep their accounts; those who only ever signed in through it need
        another way in, such as a sign-in link.
      </p>
      {problem && (
        <p className="auth-error" role="alert">
          {problem}
        </p>
      )}
      <div className="admin-panel-actions">
        <button ref={confirm} type="button" className="button button-small button-danger" disabled={busy} onClick={remove}>
          {busy ? 'Removing' : 'Remove'}
        </button>
        <button type="button" className="auth-reset" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function SsoForm({
  connection,
  organizations,
  onSaved,
  onCancel,
}: {
  connection?: SsoConnection
  organizations: { id: string; name: string }[]
  onSaved: (c: SsoConnection) => void
  onCancel: () => void
}) {
  const key = connection?.id ?? 'new'
  const id = (field: string) => `sso-${key}-${field}`
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ text: string; field?: string } | null>(null)
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>(connection?.protocol ?? 'oidc')
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    first.current?.focus()
  }, [])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const input: SsoInput = {
      protocol,
      name: String(f.get('name') ?? ''),
      issuer: String(f.get('issuer') ?? ''),
      clientId: String(f.get('clientId') ?? ''),
      clientSecret: String(f.get('clientSecret') ?? ''),
      allowedDomains: String(f.get('allowedDomains') ?? '')
        .split(/[\s,]+/)
        .filter(Boolean),
      organizationId: String(f.get('organizationId') ?? '') || null,
      trustEmail: f.get('trustEmail') === 'on',
      required: f.get('required') === 'on',
      enabled: f.get('enabled') === 'on',
      ...(protocol === 'saml'
        ? {
            metadataUrl: String(f.get('metadataUrl') ?? ''),
            metadataXml: String(f.get('metadataXml') ?? ''),
            emailAttribute: String(f.get('emailAttribute') ?? ''),
            nameAttribute: String(f.get('nameAttribute') ?? ''),
            allowIdpInitiated: f.get('allowIdpInitiated') === 'on',
          }
        : {}),
    }
    setBusy(true)
    setProblem(null)
    try {
      onSaved(connection ? await updateSso(connection.id, input) : await createSso(input))
    } catch (err) {
      setProblem({ text: errorText(err, 'The connection could not be saved. Try again.'), field: err instanceof ApiError ? err.field : undefined })
      setBusy(false)
    }
  }

  const invalid = (field: string) => (problem?.field === field ? true : undefined)
  const describedBy = (field: string, hint?: string) => [hint, invalid(field) && id('error')].filter(Boolean).join(' ') || undefined

  return (
    <form className="settings-form sso-form" onSubmit={onSubmit} noValidate aria-label={connection ? `Edit ${connection.name}` : 'Add a provider'}>
      {!connection && (
        <fieldset className="admin-policies">
          <legend className="settings-label">Protocol</legend>
          <label className="admin-policy">
            <input type="radio" name="protocol" value="oidc" checked={protocol === 'oidc'} onChange={() => setProtocol('oidc')} />
            <span>
              <strong>OpenID Connect</strong>
              <span>An issuer URL, a client ID and a client secret.</span>
            </span>
          </label>
          <label className="admin-policy">
            <input type="radio" name="protocol" value="saml" checked={protocol === 'saml'} onChange={() => setProtocol('saml')} />
            <span>
              <strong>SAML</strong>
              <span>The IdP’s metadata, by URL or as XML.</span>
            </span>
          </label>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor={id('name')}>Name on the button</label>
        <input
          ref={first}
          id={id('name')}
          name="name"
          className="admin-input"
          defaultValue={connection?.name ?? ''}
          maxLength={40}
          placeholder="Okta"
          required
          aria-invalid={invalid('name')}
          aria-describedby={describedBy('name', id('name-hint'))}
        />
        <p id={id('name-hint')} className="field-hint">
          The sign-in page shows “Continue with” and this name.
        </p>
      </div>
      {protocol === 'oidc' ? (
        <>
          <div className="field">
            <label htmlFor={id('issuer')}>Issuer URL</label>
            <input
              id={id('issuer')}
              name="issuer"
              type="url"
              className="admin-input"
              defaultValue={connection?.issuer ?? ''}
              placeholder="https://acme.okta.com"
              spellCheck={false}
              required
              aria-invalid={invalid('issuer')}
              aria-describedby={describedBy('issuer', id('issuer-hint'))}
            />
            <p id={id('issuer-hint')} className="field-hint">
              The server reads the provider’s settings from this address plus /.well-known/openid-configuration.
            </p>
          </div>
          <div className="field">
            <label htmlFor={id('clientId')}>Client ID</label>
            <input
              id={id('clientId')}
              name="clientId"
              className="admin-input"
              defaultValue={connection?.clientId ?? ''}
              spellCheck={false}
              autoComplete="off"
              required
              aria-invalid={invalid('clientId')}
              aria-describedby={describedBy('clientId')}
            />
          </div>
          <div className="field">
            <label htmlFor={id('clientSecret')}>Client secret</label>
            <input
              id={id('clientSecret')}
              name="clientSecret"
              type="password"
              className="admin-input"
              autoComplete="new-password"
              required={!connection}
              aria-invalid={invalid('clientSecret')}
              aria-describedby={describedBy('clientSecret', id('secret-hint'))}
            />
            <p id={id('secret-hint')} className="field-hint">
              {connection ? 'Leave empty to keep the current secret. ' : ''}Stored encrypted, and never shown again.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor={id('metadataUrl')}>Metadata URL</label>
            <input
              id={id('metadataUrl')}
              name="metadataUrl"
              type="url"
              className="admin-input"
              defaultValue={connection?.saml?.metadataUrl ?? ''}
              placeholder="https://acme.okta.com/app/…/sso/saml/metadata"
              spellCheck={false}
              aria-invalid={invalid('metadataUrl')}
              aria-describedby={describedBy('metadataUrl', id('metadata-hint'))}
            />
          </div>
          <div className="field">
            <label htmlFor={id('metadataXml')}>Or paste the metadata XML</label>
            <textarea
              id={id('metadataXml')}
              name="metadataXml"
              className="admin-textarea"
              rows={3}
              spellCheck={false}
              placeholder="<md:EntityDescriptor …"
              aria-invalid={invalid('metadataXml')}
              aria-describedby={describedBy('metadataXml', id('metadata-hint'))}
            />
            <p id={id('metadata-hint')} className="field-hint">
              {connection?.saml
                ? `Now: ${connection.saml.idpEntityId}, ${connection.saml.certificates} signing certificate${connection.saml.certificates === 1 ? '' : 's'}. Leave both empty to keep it; a URL is downloaded again on every save.`
                : 'A URL is downloaded again on every save, which picks up a new signing certificate.'}
            </p>
          </div>
          <div className="field">
            <label htmlFor={id('emailAttribute')}>Email attribute</label>
            <input
              id={id('emailAttribute')}
              name="emailAttribute"
              className="admin-input"
              defaultValue={connection?.saml?.emailAttribute ?? ''}
              placeholder="email"
              spellCheck={false}
              aria-describedby={id('attr-hint')}
            />
          </div>
          <div className="field">
            <label htmlFor={id('nameAttribute')}>Name attribute</label>
            <input
              id={id('nameAttribute')}
              name="nameAttribute"
              className="admin-input"
              defaultValue={connection?.saml?.nameAttribute ?? ''}
              placeholder="displayName"
              spellCheck={false}
              aria-describedby={id('attr-hint')}
            />
            <p id={id('attr-hint')} className="field-hint">
              Optional. Leave empty to read the usual attributes from Okta, Entra ID and Google Workspace.
            </p>
          </div>
          <div className="field">
            <label className="settings-check">
              <input type="checkbox" name="allowIdpInitiated" defaultChecked={connection?.saml?.allowIdpInitiated ?? false} aria-describedby={id('idp-hint')} />
              <span>Allow sign-in started from the IdP’s app dashboard</span>
            </label>
            <p id={id('idp-hint')} className="field-hint">
              Off is safer: such sign-ins can’t be tied to the browser that asked for them.
            </p>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor={id('allowedDomains')}>Email domains</label>
        <textarea
          id={id('allowedDomains')}
          name="allowedDomains"
          className="admin-textarea"
          rows={2}
          defaultValue={connection?.allowedDomains.join('\n') ?? ''}
          placeholder="acme.com"
          spellCheck={false}
          aria-invalid={invalid('allowedDomains')}
          aria-describedby={describedBy('allowedDomains', id('domains-hint'))}
        />
        <p id={id('domains-hint')} className="field-hint">
          Only addresses at these domains can sign in through this provider, and new accounts at them are created whatever the sign-up policy. Leave empty for
          any address; new accounts then follow the sign-up policy.
        </p>
      </div>
      <div className="field">
        <label htmlFor={id('organizationId')}>Organization for new people</label>
        <select
          id={id('organizationId')}
          name="organizationId"
          className="admin-input"
          defaultValue={connection?.organizationId ?? ''}
          aria-invalid={invalid('organizationId')}
          aria-describedby={describedBy('organizationId', id('org-hint'))}
        >
          <option value="">None</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <p id={id('org-hint')} className="field-hint">
          People join it as members the first time they sign in through this provider.
        </p>
      </div>
      {protocol === 'oidc' && (
        <div className="field">
          <label className="settings-check">
            <input type="checkbox" name="trustEmail" defaultChecked={connection?.trustEmail ?? false} aria-describedby={id('trust-hint')} />
            <span>Trust addresses the provider doesn’t mark as verified</span>
          </label>
          <p id={id('trust-hint')} className="field-hint">
            Only for providers that don’t send email_verified, such as Microsoft Entra ID, and only when your IT team controls every address there.
          </p>
        </div>
      )}
      <div className="field">
        <label className="settings-check">
          <input type="checkbox" name="required" defaultChecked={connection?.required ?? false} aria-describedby={id('required-hint')} />
          <span>Require single sign-on for these addresses</span>
        </label>
        <p id={id('required-hint')} className="field-hint">
          People at the domains above (everyone, when there are none) can’t sign in with a password, an email link, Google or a passkey. Instance admins always
          can, so you can’t be locked out.
        </p>
      </div>
      <div className="field">
        <label className="settings-check">
          <input type="checkbox" name="enabled" defaultChecked={connection?.enabled ?? false} aria-describedby={id('enabled-hint')} />
          <span>Show on the sign-in page</span>
        </label>
        <p id={id('enabled-hint')} className="field-hint">
          {protocol === 'oidc' ? (
            <>
              Leave off until <strong>Test connection</strong> works.
            </>
          ) : (
            'Turn it on once the IdP has this server’s entity ID and ACS URL.'
          )}
        </p>
      </div>
      {problem && (
        <p id={id('error')} className="auth-error" role="alert">
          {problem.text}
        </p>
      )}
      <div className="admin-panel-actions">
        <button type="submit" className="button button-small" disabled={busy}>
          {busy ? 'Checking the provider' : connection ? 'Save' : 'Add provider'}
        </button>
        <button type="button" className="auth-reset" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
