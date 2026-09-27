import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  changePassword,
  deleteAccount,
  disconnectAgent,
  getDeletionPreview,
  listAgents,
  updateProfile,
  type ConnectedAgent,
  type DeletionPreview,
  type Me,
} from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { timeAgo } from '../time'
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
    { id: 'agents', label: 'Connected agents' },
    { id: 'delete', label: 'Delete account' },
  ]

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="app-main settings">
        <div className="app-title">
          <h1>Account settings</h1>
          <p>
            Your profile{showPassword ? ', password' : ''} and the agents that publish for you, the same in every workspace.
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
            <AgentsSection />
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

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const password = String(data.get('password') ?? '')
    if (password !== String(data.get('confirm') ?? '')) return setStatus({ tone: 'bad', text: 'The new passwords don’t match.' })
    setSaving(true)
    setStatus(null)
    try {
      await changePassword(String(data.get('current') ?? ''), password)
      form.reset()
      onSaved()
      setStatus({ tone: 'ok', text: 'Saved. Other devices were logged out.' })
    } catch (err) {
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
        <div>
          <button type="submit" className="button button-small" disabled={saving}>
            {saving ? 'Saving' : me.hasPassword ? 'Change password' : 'Set password'}
          </button>
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
        <p>Deletes your account, your personal pages and your agent connections. People you shared personal pages with lose access. This can't be undone.</p>
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
