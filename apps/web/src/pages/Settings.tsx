import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import {
  ApiError,
  changePassword,
  createAccessToken,
  deleteAccount,
  disconnectAgent,
  FieldError,
  getDeletionPreview,
  listAccessTokens,
  listAgents,
  revokeAccessToken,
  TOKEN_EXPIRY_DAYS,
  updateProfile,
  type AccessToken,
  type ConnectedAgent,
  type DeletionPreview,
  type Me,
} from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { CopyCommand } from '../components/CopyCommand'
import { ExportSection } from '../components/ExportSection'
import { SecuritySection, SessionsSection, signInAgain } from '../components/SignInSecurity'
import { WebhooksSection } from '../components/Webhooks'
import { expiryText, timeAgo } from '../time'
import { useConfig } from '../useConfig'
import { useMe } from '../useMe'
import { chooseWorkspace, organizationSettingsPath, useWorkspace } from '../workspace'
import { LoadError, Loading } from './Status'
import './Workspace.css'
import './Settings.css'

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export function Settings() {
  const state = useMe()

  useEffect(() => {
    document.title = 'Account settings | The Artifact'
    return () => {
      document.title = 'The Artifact'
    }
  }, [])

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  return <SettingsPage initial={state.me} />
}

// Settings for you as a person, the same in every workspace. Organizations have their own
// settings page, and the server has its admin area.
function SettingsPage({ initial }: { initial: Me }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [me, setMe] = useState(initial)
  const { org, name } = useWorkspace(me)
  const config = useConfig()
  // Passwords are for servers without email, and for anyone who already has one
  const showPassword = me.hasPassword || config?.emailSignIn === false

  // Links like /settings#delete arrive before the sections exist. The organization section moved
  // to its own page, so older /settings#organization links go there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on arrival
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id === 'organization') {
      navigate(org ? organizationSettingsPath(org) : '/settings', { replace: true })
      return
    }
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  const sections = [
    { id: 'profile', label: 'Profile' },
    ...(showPassword ? [{ id: 'password', label: 'Password' }] : []),
    { id: 'security', label: 'Sign-in security' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'agents', label: 'Connected agents' },
    { id: 'tokens', label: 'Access tokens' },
    { id: 'export', label: 'Export your data' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'delete', label: 'Delete account' },
  ]

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="app-main settings">
        <div className="app-title">
          <h1>Account settings</h1>
          <p>
            Your profile, how you sign in, and the agents and access tokens that publish for you, the same in every workspace.
            {org && (
              <>
                {' '}
                For members and invitations, open{' '}
                <Link className="text-link" to={organizationSettingsPath(org)}>
                  {org.name} settings
                </Link>
                .
              </>
            )}
          </p>
        </div>

        <div className="settings-layout">
          <nav className="settings-rail" aria-label="Settings sections">
            <ol>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.label}</a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="settings-sections">
            <ProfileSection me={me} onSaved={(n) => setMe({ ...me, name: n })} />
            {showPassword && <PasswordSection me={me} onSaved={() => setMe({ ...me, hasPassword: true })} />}
            <SecuritySection required={params.get('two-factor') === 'required'} />
            <SessionsSection />
            <AgentsSection />
            <TokensSection me={me} defaultWorkspace={org?.id ?? null} />
            <ExportSection organization={null} />
            <WebhooksSection workspace="personal" name="your personal workspace" />
            <DeleteSection me={me} />
          </div>
        </div>
      </main>
    </div>
  )
}

function ProfileSection({ me, onSaved }: { me: Me; onSaved: (name: string) => void }) {
  const [value, setValue] = useState(me.name ?? '')
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const unchanged = value.trim() === (me.name ?? '')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    try {
      const { name } = await updateProfile(value)
      onSaved(name)
      setValue(name)
      setStatus({ tone: 'ok', text: 'Saved.' })
    } catch (err) {
      setStatus({ tone: 'bad', text: errorText(err, 'Your name could not be saved. Try again.') })
    }
    setSaving(false)
  }

  return (
    <section id="profile" className="settings-card" aria-labelledby="profile-title">
      <header className="settings-card-head">
        <h2 id="profile-title">Profile</h2>
        <p>How you appear to people you share pages with and to your teammates.</p>
      </header>
      <form className="settings-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="profile-name">Display name</label>
          <div className="settings-inline">
            <input
              id="profile-name"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setStatus(null)
              }}
              maxLength={80}
              required
              autoComplete="name"
              aria-describedby="profile-status"
            />
            <button type="submit" className="button button-small" disabled={saving || unchanged || !value.trim()}>
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
          <p id="profile-status" className="field-hint" data-tone={status?.tone} aria-live="polite">
            {status?.text ?? ''}
          </p>
        </div>
        <div className="field">
          <span className="settings-label">Email</span>
          <p className="settings-value">{me.email}</p>
        </div>
      </form>
    </section>
  )
}

function PasswordSection({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  // Adding a first password needs a sign-in from the last hour
  const [reauth, setReauth] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const password = String(data.get('password') ?? '')
    if (password !== String(data.get('confirm') ?? '')) return setStatus({ tone: 'bad', text: 'The new passwords don’t match.' })
    setSaving(true)
    setStatus(null)
    try {
      const signOutAgents = data.get('signOutAgents') === 'on'
      await changePassword(String(data.get('current') ?? ''), password, signOutAgents)
      form.reset()
      setReauth(false)
      onSaved()
      setStatus({
        tone: 'ok',
        text: signOutAgents ? 'Saved. Other devices were logged out, and agents and access tokens stopped working.' : 'Saved. Other devices were logged out.',
      })
    } catch (err) {
      setReauth(err instanceof ApiError && err.code === 'reauth_required')
      setStatus({ tone: 'bad', text: errorText(err, 'Your password could not be changed. Try again.') })
    }
    setSaving(false)
  }

  return (
    <section id="password" className="settings-card" aria-labelledby="password-title">
      <header className="settings-card-head">
        <h2 id="password-title">Password</h2>
        <p>{me.hasPassword ? 'Change the password you log in with.' : 'You sign in with Google. Set a password to log in without it too.'}</p>
      </header>
      <form className="settings-form" onSubmit={onSubmit} noValidate>
        <input type="email" name="username" autoComplete="username" value={me.email} readOnly hidden />
        {me.hasPassword && (
          <div className="field">
            <label htmlFor="password-current">Current password</label>
            <input id="password-current" name="current" type="password" autoComplete="current-password" required />
          </div>
        )}
        <div className="field">
          <label htmlFor="password-new">New password</label>
          <input id="password-new" name="password" type="password" autoComplete="new-password" minLength={8} required aria-describedby="password-status" />
        </div>
        <div className="field">
          <label htmlFor="password-confirm">Confirm new password</label>
          <input id="password-confirm" name="confirm" type="password" autoComplete="new-password" required />
        </div>
        <div className="field">
          <label className="settings-check">
            <input type="checkbox" name="signOutAgents" aria-describedby="password-agents-hint" />
            <span>Also disconnect agents and revoke access tokens</span>
          </label>
          <p id="password-agents-hint" className="field-hint">
            Choose this if someone else may have used your account. Agents need to connect again, and scripts need new tokens.
          </p>
        </div>
        <div className="settings-buttons">
          <button type="submit" className="button button-small" disabled={saving}>
            {saving ? 'Saving' : me.hasPassword ? 'Change password' : 'Set password'}
          </button>
          {reauth && (
            <button type="button" className="button button-small button-quiet" onClick={() => signInAgain('password')}>
              Sign in again
            </button>
          )}
        </div>
        <p id="password-status" className="field-hint" data-tone={status?.tone} aria-live="polite">
          {status?.text ?? 'At least 8 characters.'}
        </p>
      </form>
    </section>
  )
}

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

function AgentsSection() {
  const [agents, setAgents] = useState<Loadable<ConnectedAgent[]>>({ kind: 'loading' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listAgents()
      .then((data) => active && setAgents({ kind: 'ready', data }))
      .catch(() => active && setAgents({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  async function disconnect(agent: ConnectedAgent) {
    setProblem(null)
    try {
      await disconnectAgent(agent.clientId)
      setAgents((a) => (a.kind === 'ready' ? { kind: 'ready', data: a.data.filter((x) => x.clientId !== agent.clientId) } : a))
    } catch (err) {
      setProblem(errorText(err, `${agent.name} could not be disconnected. Try again.`))
    }
    setConfirming(null)
  }

  return (
    <section id="agents" className="settings-card" aria-labelledby="agents-title">
      <header className="settings-card-head">
        <h2 id="agents-title">Connected agents</h2>
        <p>Agents that can publish pages for you. Disconnecting one signs it out; it asks you to sign in again next time.</p>
      </header>

      {agents.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading agents
        </p>
      )}
      {agents.kind === 'error' && (
        <p className="auth-notice" role="alert">
          Your agents could not be loaded. Reload to try again.
        </p>
      )}
      {agents.kind === 'ready' && agents.data.length === 0 && (
        <p className="settings-muted">
          No agents are connected.{' '}
          <Link className="text-link" to="/app">
            Connect one from your pages
          </Link>
          .
        </p>
      )}
      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}

      {agents.kind === 'ready' && agents.data.length > 0 && (
        <ul className="settings-list">
          {agents.data.map((a) => (
            <li key={a.clientId} className="settings-row">
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                {a.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="settings-who">
                <strong>{a.name}</strong>
                <span>Publishes to {a.workspaces.join(', ')}</span>
              </span>
              <span className="settings-meta">{a.lastUsedAt ? `Last used ${timeAgo(a.lastUsedAt)}` : `Connected ${timeAgo(a.connectedAt)}, not used yet`}</span>
              <span className="settings-actions">
                {confirming === a.clientId ? (
                  <>
                    <button type="button" className="button button-small button-danger" onClick={() => disconnect(a)}>
                      Disconnect
                    </button>
                    <button type="button" className="auth-reset" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="button button-small button-quiet" onClick={() => setConfirming(a.clientId)}>
                    Disconnect
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const EXPIRY_LABEL: Record<number, string> = { 7: '7 days', 30: '30 days', 90: '90 days', 365: '1 year' }

// Tokens for publishing from CI and scripts. A new token is shown here once, right after it is made.
function TokensSection({ me, defaultWorkspace }: { me: Me; defaultWorkspace: string | null }) {
  const [tokens, setTokens] = useState<Loadable<AccessToken[]>>({ kind: 'loading' })
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listAccessTokens()
      .then((data) => active && setTokens({ kind: 'ready', data }))
      .catch(() => active && setTokens({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  async function revoke(t: AccessToken) {
    setProblem(null)
    try {
      await revokeAccessToken(t.id)
      setTokens((a) => (a.kind === 'ready' ? { kind: 'ready', data: a.data.filter((x) => x.id !== t.id) } : a))
    } catch (err) {
      setProblem(errorText(err, `${t.name} could not be revoked. Try again.`))
    }
    setConfirming(null)
  }

  return (
    <section id="tokens" className="settings-card" aria-labelledby="tokens-title">
      <header className="settings-card-head">
        <h2 id="tokens-title">Access tokens</h2>
        <p>
          For publishing from CI and scripts, where an agent can’t sign in. A token acts for you in one workspace, with your permissions. Revoking one stops it
          at once.{' '}
          <Link className="text-link" to="/docs/connect-your-agent#publishing-from-ci">
            How to use one
          </Link>
        </p>
      </header>

      {created ? (
        <div className="settings-token-new" role="status">
          <p>
            <strong>Copy the token for {created.name} now.</strong> You won’t be able to see it again. Keep it in a secret, like a GitHub Actions secret.
          </p>
          <CopyCommand command={created.token} label="Copy token" plain />
          <div>
            <button type="button" className="button button-small button-quiet" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <TokenForm
          me={me}
          defaultWorkspace={defaultWorkspace}
          onCreated={(token, accessToken) => {
            setCreated({ token, name: accessToken.name })
            setTokens((a) => (a.kind === 'ready' ? { kind: 'ready', data: [accessToken, ...a.data] } : a))
          }}
        />
      )}

      {tokens.kind === 'error' && (
        <p className="auth-notice" role="alert">
          Your access tokens could not be loaded. Reload to try again.
        </p>
      )}
      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}
      {tokens.kind === 'ready' && tokens.data.length > 0 && (
        <ul className="settings-list" aria-label="Access tokens">
          {tokens.data.map((t) => (
            <li key={t.id} className="settings-row">
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                {t.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="settings-who">
                <strong>{t.name}</strong>
                <span>
                  Publishes to {t.workspace.name}, created {timeAgo(t.createdAt)}
                </span>
                <span>{t.lastUsedAt ? `Last used ${timeAgo(t.lastUsedAt)}` : 'Not used yet'}</span>
              </span>
              <span className="settings-meta" data-tone={t.expired ? 'bad' : undefined}>
                {expiryText(t)}
              </span>
              <span className="settings-actions">
                {confirming === t.id ? (
                  <>
                    <button type="button" className="button button-small button-danger" onClick={() => revoke(t)}>
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
    </section>
  )
}

function TokenForm({
  me,
  defaultWorkspace,
  onCreated,
}: {
  me: Me
  defaultWorkspace: string | null
  onCreated: (token: string, accessToken: AccessToken) => void
}) {
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState(defaultWorkspace ?? 'personal')
  const [expiry, setExpiry] = useState('90')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Creating a token needs a sign-in from the last hour
  const [reauth, setReauth] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    setReauth(false)
    try {
      const { token, accessToken } = await createAccessToken({
        name,
        organizationId: workspace === 'personal' ? null : workspace,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      })
      setName('')
      onCreated(token, accessToken)
    } catch (err) {
      setReauth(err instanceof ApiError && err.code === 'reauth_required')
      setStatus(errorText(err, 'The token could not be created. Try again.'))
      if (err instanceof FieldError && err.field === 'name') document.getElementById('token-name')?.focus()
    }
    setSaving(false)
  }

  return (
    <form className="settings-token-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="token-name">Name</label>
        <input
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nightly test report"
          maxLength={60}
          required
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor="token-workspace">Workspace</label>
        <select id="token-workspace" className="settings-select" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          <option value="personal">Personal</option>
          {me.organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="token-expiry">Expires after</label>
        <select id="token-expiry" className="settings-select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {TOKEN_EXPIRY_DAYS.map((d) => (
            <option key={d} value={String(d)}>
              {EXPIRY_LABEL[d]}
            </option>
          ))}
          <option value="never">No expiry</option>
        </select>
      </div>
      <button type="submit" className="button button-small" disabled={saving || !name.trim()}>
        {saving ? 'Creating' : 'Create token'}
      </button>
      <p className="field-hint settings-token-hint" data-tone={status ? 'bad' : undefined} aria-live="polite">
        {status ?? 'You see the token once, right after you create it.'}
      </p>
      {reauth && (
        <div className="settings-token-hint">
          <button type="button" className="button button-small button-quiet" onClick={() => signInAgain('tokens')}>
            Sign in again
          </button>
        </div>
      )}
    </form>
  )
}

const pagesText = (n: number) => (n === 1 ? '1 page' : `${n} pages`)

// What happens to pages and organizations, from the deletion preview
function DeletionSummary({ preview }: { preview: DeletionPreview }) {
  const { pages, transfers, deletesOrganizations: orgs } = preview
  return (
    <ul className="deletion-summary">
      <li data-kind="delete">
        <strong>{pages.deleted === 0 ? 'No pages' : pagesText(pages.deleted)} deleted.</strong>{' '}
        {pages.deleted === 0
          ? 'You have no personal pages.'
          : `Everything in your personal workspace${orgs.length ? ` and in ${orgs.join(', ')}` : ''}, with its history.`}
      </li>
      {transfers.map((t) => (
        <li key={t.organization} data-kind="keep">
          <strong>
            {pagesText(t.pages)} in {t.organization} {t.pages === 1 ? 'stays' : 'stay'}.
          </strong>{' '}
          {t.pages === 1 ? 'It moves' : 'They move'} to {t.to}, with {t.pages === 1 ? 'its' : 'their'} history and sharing.
        </li>
      ))}
      {orgs.length > 0 && (
        <li data-kind="delete">
          <strong>{orgs.join(', ')} deleted.</strong> {orgs.length === 1 ? 'It has' : 'They have'} nobody else in {orgs.length === 1 ? 'it' : 'them'}.
        </li>
      )}
    </ul>
  )
}

function DeleteSection({ me }: { me: Me }) {
  const navigate = useNavigate()
  const [preview, setPreview] = useState<DeletionPreview | null>(null)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const matches = typed.trim().toLowerCase() === me.email

  useEffect(() => {
    let active = true
    getDeletionPreview()
      .then((p) => active && setPreview(p))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setDeleting(true)
    setProblem(null)
    try {
      await deleteAccount(typed)
      chooseWorkspace('personal')
      navigate('/', { replace: true })
    } catch (err) {
      setProblem(errorText(err, 'Your account could not be deleted. Try again.'))
      setDeleting(false)
    }
  }

  const blocked = preview?.blockedBy ?? []

  return (
    <section id="delete" className="settings-card settings-danger" aria-labelledby="delete-title">
      <header className="settings-card-head">
        <h2 id="delete-title">Delete account</h2>
        <p>
          Deletes your account, your personal pages, your agent connections and your access tokens. People you shared personal pages with lose access. This
          can't be undone.
        </p>
      </header>

      {preview && preview.blockedBy.length === 0 && <DeletionSummary preview={preview} />}

      {blocked.length > 0 ? (
        <div className="auth-notice" role="alert">
          You are the only owner of {blocked.map((o) => o.name).join(', ')}, and other people are in {blocked.length === 1 ? 'it' : 'them'}. Make someone else
          an owner, or remove the other members, before you delete your account.
        </div>
      ) : (
        <form className="settings-form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="delete-confirm">
              Type <strong>{me.email}</strong> to confirm
            </label>
            <div className="settings-inline">
              <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" />
              <button type="submit" className="button button-small button-danger" disabled={!matches || deleting}>
                {deleting ? 'Deleting' : 'Delete account'}
              </button>
            </div>
          </div>
          {problem && (
            <p className="auth-notice" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
    </section>
  )
}
