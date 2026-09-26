import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  deleteAccount,
  disconnectAgent,
  fetchMe,
  getDeletionPreview,
  getOrganization,
  inviteMember,
  listAgents,
  logout,
  removeMember,
  renameOrganization,
  revokeInvitation,
  setMemberRole,
  updateProfile,
  type ConnectedAgent,
  type DeletionPreview,
  type InviteRole,
  type Me,
  type Organization,
  type OrganizationDetails,
  type OrganizationMember,
  type Role,
} from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { timeAgo } from '../time'
import { useMe } from '../useMe'
import { chooseWorkspace, useWorkspace } from '../workspace'
import { LoadError, Loading } from './Status'
import './Workspace.css'
import './Settings.css'

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

// Roles a person with `actor` role may hand out, and whose holders they may manage
function assignable(actor: Role): Role[] {
  if (actor === 'owner') return ['owner', 'admin', 'member']
  if (actor === 'admin') return ['admin', 'member']
  return []
}

const canManage = (actor: Role, target: Role) => assignable(actor).includes(target)
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export function Settings() {
  const state = useMe()

  useEffect(() => {
    document.title = 'Settings | The Artifact'
    return () => { document.title = 'The Artifact' }
  }, [])

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  return <SettingsPage initial={state.me} />
}

function SettingsPage({ initial }: { initial: Me }) {
  const [me, setMe] = useState(initial)
  const { org, name } = useWorkspace(me)
  const refreshMe = () => fetchMe().then((m) => m && setMe(m)).catch(() => {})

  // Links like /settings#organization arrive before the sections exist
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  const sections = [
    { id: 'profile', label: 'Profile' },
    { id: 'agents', label: 'Connected agents' },
    { id: 'organization', label: org ? org.name : 'Organization' },
    { id: 'delete', label: 'Delete account' },
  ]

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="app-main settings">
        <div className="app-title">
          <h1>Settings</h1>
          <p>Your profile, the agents that publish for you, and who is in {org ? org.name : 'your organizations'}.</p>
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
            <AgentsSection />
            {org ? (
              <OrganizationSection key={org.id} me={me} org={org} onChanged={refreshMe} />
            ) : (
              <PersonalNote me={me} />
            )}
            <DeleteSection me={me} />
          </div>
        </div>
      </main>
    </div>
  )
}

function ProfileSection({ me, onSaved }: { me: Me; onSaved: (name: string) => void }) {
  const navigate = useNavigate()
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
      <div className="settings-signout">
        <button
          type="button"
          className="auth-reset"
          onClick={async () => {
            await logout()
            navigate('/', { replace: true })
          }}
        >
          Log out
        </button>
      </div>
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
    return () => { active = false }
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

      {agents.kind === 'loading' && <p className="settings-muted" role="status">Loading agents</p>}
      {agents.kind === 'error' && <p className="auth-notice" role="alert">Your agents could not be loaded. Reload to try again.</p>}
      {agents.kind === 'ready' && agents.data.length === 0 && (
        <p className="settings-muted">
          No agents are connected. <Link className="text-link" to="/app">Connect one from your pages</Link>.
        </p>
      )}
      {problem && <p className="auth-notice" role="alert">{problem}</p>}

      {agents.kind === 'ready' && agents.data.length > 0 && (
        <ul className="settings-list">
          {agents.data.map((a) => (
            <li key={a.clientId} className="settings-row">
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>
              <span className="settings-who">
                <strong>{a.name}</strong>
                <span>Publishes to {a.workspaces.join(', ')}</span>
              </span>
              <span className="settings-meta">
                {a.lastUsedAt ? `Last used ${timeAgo(a.lastUsedAt)}` : `Connected ${timeAgo(a.connectedAt)}, not used yet`}
              </span>
              <span className="settings-actions">
                {confirming === a.clientId ? (
                  <>
                    <button type="button" className="button button-small button-danger" onClick={() => disconnect(a)}>
                      Disconnect
                    </button>
                    <button type="button" className="auth-reset" onClick={() => setConfirming(null)}>Cancel</button>
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

function PersonalNote({ me }: { me: Me }) {
  return (
    <section id="organization" className="settings-card" aria-labelledby="org-title">
      <header className="settings-card-head">
        <h2 id="org-title">Organization</h2>
        <p>
          You are in your Personal workspace, which is just you.
          {me.organizations.length > 0
            ? ' Switch to an organization with the workspace menu at the top to manage its members.'
            : ' Create an organization to give your team a shared gallery.'}
        </p>
      </header>
      <div>
        <Link className="button button-small button-quiet" to="/organizations/new">Create an organization</Link>
      </div>
    </section>
  )
}

function OrganizationSection({ me, org, onChanged }: { me: Me; org: Organization; onChanged: () => void }) {
  const navigate = useNavigate()
  const [details, setDetails] = useState<Loadable<OrganizationDetails>>({ kind: 'loading' })
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getOrganization(org.id)
      .then((data) => active && setDetails({ kind: 'ready', data }))
      .catch(() => active && setDetails({ kind: 'error' }))
    return () => { active = false }
  }, [org.id])

  async function run(action: () => Promise<OrganizationDetails | null>, fallback: string) {
    setProblem(null)
    try {
      const data = await action()
      if (data) setDetails({ kind: 'ready', data })
      onChanged()
      return true
    } catch (err) {
      setProblem(errorText(err, fallback))
      return false
    } finally {
      setConfirming(null)
    }
  }

  async function leave() {
    setProblem(null)
    try {
      await removeMember(org.id, me.id)
      const next = me.organizations.find((o) => o.id !== org.id)
      chooseWorkspace(next?.id ?? 'personal')
      navigate('/app')
    } catch (err) {
      setProblem(errorText(err, 'You could not leave. Try again.'))
      setConfirming(null)
    }
  }

  if (details.kind !== 'ready') {
    return (
      <section id="organization" className="settings-card" aria-labelledby="org-title">
        <header className="settings-card-head">
          <h2 id="org-title">{org.name}</h2>
        </header>
        {details.kind === 'loading' ? (
          <p className="settings-muted" role="status">Loading members</p>
        ) : (
          <p className="auth-notice" role="alert">The organization could not be loaded. Reload to try again.</p>
        )}
      </section>
    )
  }

  const d = details.data
  const manager = d.role !== 'member'
  const owners = d.members.filter((m) => m.role === 'owner').length
  const soleOwner = d.role === 'owner' && owners === 1

  return (
    <section id="organization" className="settings-card" aria-labelledby="org-title">
      <header className="settings-card-head">
        <h2 id="org-title">{d.name}</h2>
        <p>
          {d.members.length === 1 ? '1 member' : `${d.members.length} members`}. Your role: {ROLE_LABEL[d.role]}.
          {manager ? ' Owners and admins can invite people and change roles.' : ' Owners and admins manage who is in it.'}
        </p>
      </header>

      {manager && <RenameForm details={d} onRenamed={(data) => { setDetails({ kind: 'ready', data }); onChanged() }} />}

      <h3 className="settings-subhead">Members</h3>
      {problem && <p className="auth-notice" role="alert">{problem}</p>}
      <ul className="settings-list">
        {d.members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            self={m.id === me.id}
            myRole={d.role}
            lastOwner={m.role === 'owner' && owners === 1}
            confirming={confirming === m.id}
            onConfirm={(v) => setConfirming(v ? m.id : null)}
            onRole={(role) => run(() => setMemberRole(org.id, m.id, role), 'The role could not be changed. Try again.')}
            onRemove={() => (m.id === me.id ? leave() : run(() => removeMember(org.id, m.id), 'They could not be removed. Try again.'))}
          />
        ))}
      </ul>
      {soleOwner && d.members.length > 1 && (
        <p className="field-hint">You are the only owner. To leave, make someone else an owner first.</p>
      )}

      {manager && (
        <>
          <h3 className="settings-subhead">Invite people</h3>
          <InviteForm details={d} myRole={d.role} onInvited={(data) => setDetails({ kind: 'ready', data })} />
          {d.invitations.length > 0 && (
            <>
              <h3 className="settings-subhead">Pending invitations</h3>
              <ul className="settings-list">
                {d.invitations.map((i) => (
                  <li key={i.id} className="settings-row">
                    <span className="settings-avatar settings-avatar-pending" aria-hidden="true">{i.email.slice(0, 1).toUpperCase()}</span>
                    <span className="settings-who">
                      <strong>{i.email}</strong>
                      <span>
                        {ROLE_LABEL[i.role]}
                        {i.invitedBy ? `, invited by ${i.invitedBy}` : ''}
                      </span>
                    </span>
                    <span className="settings-meta" data-tone={i.expired ? 'bad' : undefined}>
                      {i.expired ? `Expired ${timeAgo(i.expiresAt)}` : `Expires ${timeAgo(i.expiresAt)}`}
                    </span>
                    <span className="settings-actions">
                      <button
                        type="button"
                        className="auth-reset"
                        onClick={() => run(async () => (await inviteMember(org.id, i.email, i.role)).organization, 'The invitation could not be sent again.')}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        className="button button-small button-quiet"
                        onClick={() => run(() => revokeInvitation(org.id, i.id), 'The invitation could not be revoked. Try again.')}
                      >
                        Revoke
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

function MemberRow({ member: m, self, myRole, lastOwner, confirming, onConfirm, onRole, onRemove }: {
  member: OrganizationMember
  self: boolean
  myRole: Role
  lastOwner: boolean
  confirming: boolean
  onConfirm: (v: boolean) => void
  onRole: (role: Role) => void
  onRemove: () => void
}) {
  const editable = canManage(myRole, m.role) && !lastOwner
  const removable = self ? !lastOwner : canManage(myRole, m.role)
  const display = m.name ?? m.email

  return (
    <li className="settings-row">
      {m.avatarUrl ? (
        <img className="settings-avatar" src={m.avatarUrl} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="settings-avatar" aria-hidden="true">{display.slice(0, 1).toUpperCase()}</span>
      )}
      <span className="settings-who">
        <strong>
          {display}
          {self && <span className="settings-you">You</span>}
        </strong>
        {m.name && <span>{m.email}</span>}
      </span>
      <span className="settings-meta">
        {editable ? (
          <select
            className="settings-select"
            value={m.role}
            aria-label={`Role for ${display}`}
            onChange={(e) => onRole(e.target.value as Role)}
          >
            {assignable(myRole).map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        ) : (
          <span className="settings-role">{ROLE_LABEL[m.role]}</span>
        )}
      </span>
      <span className="settings-actions">
        {removable &&
          (confirming ? (
            <>
              <button type="button" className="button button-small button-danger" onClick={onRemove}>
                {self ? 'Leave' : 'Remove'}
              </button>
              <button type="button" className="auth-reset" onClick={() => onConfirm(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="button button-small button-quiet" onClick={() => onConfirm(true)}>
              {self ? 'Leave' : 'Remove'}
            </button>
          ))}
      </span>
    </li>
  )
}

function RenameForm({ details, onRenamed }: { details: OrganizationDetails; onRenamed: (d: OrganizationDetails) => void }) {
  const [value, setValue] = useState(details.name)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    try {
      const data = await renameOrganization(details.id, value)
      onRenamed(data)
      setStatus({ tone: 'ok', text: 'Saved.' })
    } catch (err) {
      setStatus({ tone: 'bad', text: errorText(err, 'The name could not be saved. Try again.') })
    }
    setSaving(false)
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="org-rename">Organization name</label>
        <div className="settings-inline">
          <input id="org-rename" value={value} onChange={(e) => { setValue(e.target.value); setStatus(null) }} minLength={2} maxLength={60} required aria-describedby="org-rename-status" />
          <button type="submit" className="button button-small" disabled={saving || value.trim() === details.name || value.trim().length < 2}>
            {saving ? 'Saving' : 'Rename'}
          </button>
        </div>
        <p id="org-rename-status" className="field-hint" data-tone={status?.tone} aria-live="polite">{status?.text ?? ''}</p>
      </div>
    </form>
  )
}

function InviteForm({ details, myRole, onInvited }: { details: OrganizationDetails; myRole: Role; onInvited: (d: OrganizationDetails) => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('member')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'bad'; text: string; link?: string } | null>(null)
  const roles = assignable(myRole).filter((r): r is InviteRole => r !== 'owner')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSending(true)
    setResult(null)
    try {
      const sent = await inviteMember(details.id, email, role)
      onInvited(sent.organization)
      setResult(
        sent.emailed
          ? { tone: 'ok', text: `Invitation sent to ${email.trim().toLowerCase()}.` }
          : { tone: 'bad', text: 'The email could not be sent. Share this link with them instead:', link: sent.link },
      )
      setEmail('')
    } catch (err) {
      setResult({ tone: 'bad', text: errorText(err, 'The invitation could not be sent. Try again.') })
    }
    setSending(false)
  }

  return (
    <form className="settings-invite" onSubmit={onSubmit}>
      <label className="visually-hidden" htmlFor="invite-email">Email address</label>
      <input
        id="invite-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@company.com"
        autoComplete="off"
        required
      />
      <label className="visually-hidden" htmlFor="invite-role">Role</label>
      <select id="invite-role" className="settings-select" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
        {roles.map((r) => (
          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
        ))}
      </select>
      <button type="submit" className="button button-small" disabled={sending || !email.trim()}>
        {sending ? 'Sending' : 'Send invite'}
      </button>
      <p className="field-hint settings-invite-hint" data-tone={result?.tone} aria-live="polite">
        {result ? result.text : `They get an email with a link to join ${details.name}. It works for 7 days.`}
        {result?.link && <code className="settings-link">{result.link}</code>}
      </p>
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
          <strong>{pagesText(t.pages)} in {t.organization} {t.pages === 1 ? 'stays' : 'stay'}.</strong>{' '}
          {t.pages === 1 ? 'It moves' : 'They move'} to {t.to}, with {t.pages === 1 ? 'its' : 'their'} history and sharing.
        </li>
      ))}
      {orgs.length > 0 && (
        <li data-kind="delete">
          <strong>{orgs.join(', ')} deleted.</strong> {orgs.length === 1 ? 'It has' : 'They have'} nobody else in{' '}
          {orgs.length === 1 ? 'it' : 'them'}.
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
    getDeletionPreview().then((p) => active && setPreview(p)).catch(() => {})
    return () => { active = false }
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
          Deletes your account, your personal pages and your agent connections. People you shared personal pages with
          lose access. This can't be undone.
        </p>
      </header>

      {preview && preview.blockedBy.length === 0 && <DeletionSummary preview={preview} />}

      {blocked.length > 0 ? (
        <div className="auth-notice" role="alert">
          You are the only owner of {blocked.map((o) => o.name).join(', ')}, and other people are in{' '}
          {blocked.length === 1 ? 'it' : 'them'}. Make someone else an owner, or remove the other members, before you delete
          your account.
        </div>
      ) : (
        <form className="settings-form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="delete-confirm">
              Type <strong>{me.email}</strong> to confirm
            </label>
            <div className="settings-inline">
              <input
                id="delete-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
              <button type="submit" className="button button-small button-danger" disabled={!matches || deleting}>
                {deleting ? 'Deleting' : 'Delete account'}
              </button>
            </div>
          </div>
          {problem && <p className="auth-notice" role="alert">{problem}</p>}
        </form>
      )}
    </section>
  )
}
