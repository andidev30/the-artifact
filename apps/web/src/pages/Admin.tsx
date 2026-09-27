import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Me } from '../api'
import {
  deleteOrganization,
  deleteUser,
  getOverview,
  getSettings,
  getUserDeletion,
  listOrganizations,
  listUsers,
  createSignUpLink,
  saveSettings,
  updateUser,
  type AdminOrganization,
  type AdminOverview,
  type AdminUser,
  type InstanceSettings,
  type SignUpLink,
  type SignupPolicy,
  type UserDeletionPreview,
  type UserFilter,
} from '../adminApi'
import { AccountHeader } from '../components/AccountHeader'
import { CopyCommand } from '../components/CopyCommand'
import { useConfig } from '../useConfig'
import { timeAgo } from '../time'
import { useMe } from '../useMe'
import { useWorkspace } from '../workspace'
import { LoadError, Loading } from './Status'
import './Workspace.css'
import './Settings.css'
import './Admin.css'

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

export function Admin() {
  const state = useMe()

  useEffect(() => {
    document.title = 'Server admin | The Artifact'
    return () => { document.title = 'The Artifact' }
  }, [])

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  return state.me.isAdmin ? <AdminPage me={state.me} /> : <NotAdmin me={state.me} />
}

function NotAdmin({ me }: { me: Me }) {
  const { name } = useWorkspace(me)
  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="app-main">
        <div className="app-title">
          <h1>Server admin</h1>
          <p className="app-note">Only the admins of this server can open this page.</p>
        </div>
        <p className="app-note">
          <Link className="text-link" to="/app">Back to your pages</Link>
        </p>
      </main>
    </div>
  )
}

function AdminPage({ me }: { me: Me }) {
  const { name } = useWorkspace(me)
  // Bumped after any change so the counts at the top stay current
  const [version, setVersion] = useState(0)
  const changed = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])

  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'people', label: 'People' },
    { id: 'organizations', label: 'Organizations' },
    { id: 'signup', label: 'Sign-up' },
  ]

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={name} />
      <main id="main" className="app-main settings admin">
        <div className="app-title">
          <h1>Server admin</h1>
          <p>Everyone on this instance, their organizations, and who can create an account.</p>
        </div>

        <div className="settings-layout">
          <nav className="settings-rail" aria-label="Admin sections">
            <ol>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.label}</a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="settings-sections">
            <OverviewSection version={version} />
            <PeopleSection onChanged={changed} />
            <OrganizationsSection onChanged={changed} />
            <SignupSection onChanged={changed} />
          </div>
        </div>
      </main>
    </div>
  )
}

const POLICY_LABEL: Record<SignupPolicy, string> = {
  open: 'Anyone can sign up',
  domains: 'Only listed email domains',
  'invite-only': 'Invited people only',
}

function OverviewSection({ version }: { version: number }) {
  const [overview, setOverview] = useState<Loadable<AdminOverview>>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    getOverview()
      .then((data) => active && setOverview({ kind: 'ready', data }))
      .catch(() => active && setOverview((o) => (o.kind === 'ready' ? o : { kind: 'error' })))
    return () => { active = false }
  }, [version])

  return (
    <section id="overview" className="settings-card" aria-labelledby="overview-title">
      <header className="settings-card-head">
        <h2 id="overview-title">Overview</h2>
        {overview.kind === 'ready' && (
          <p>
            {POLICY_LABEL[overview.data.signupPolicy]}
            {overview.data.signupPolicy === 'domains' && overview.data.allowedDomains.length > 0 && ` (${overview.data.allowedDomains.join(', ')})`}.
            {' '}
            <a className="text-link" href="#signup">Change</a>
          </p>
        )}
      </header>
      {overview.kind === 'loading' && <p className="settings-muted" role="status">Loading counts</p>}
      {overview.kind === 'error' && <p className="auth-notice" role="alert">The counts could not be loaded. Reload to try again.</p>}
      {overview.kind === 'ready' && (
        <dl className="admin-stats">
          <Stat label="People" value={overview.data.users} note={`${overview.data.newThisWeek.toLocaleString('en')} new this week`} />
          <Stat label="Active this week" value={overview.data.activeThisWeek} note={`${overview.data.peopleWithAgents.toLocaleString('en')} with an agent connected`} />
          <Stat label="Organizations" value={overview.data.organizations} />
          <Stat label="Pages" value={overview.data.pages} />
          <Stat label="Admins" value={overview.data.admins} />
          <Stat label="Suspended" value={overview.data.suspended} />
        </dl>
      )}
    </section>
  )
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="admin-stat">
      <dt>{label}</dt>
      <dd>
        <strong>{value.toLocaleString('en')}</strong>
        {note && <span>{note}</span>}
      </dd>
    </div>
  )
}

// A search box whose value settles 250 ms after the last keystroke
function useSearch() {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 250)
    return () => clearTimeout(t)
  }, [input])
  return { input, setInput, query }
}

type List<T> = { items: T[]; total: number; pageSize: number }

function PeopleSection({ onChanged }: { onChanged: () => void }) {
  const config = useConfig()
  const noEmail = config?.emailSignIn === false
  const search = useSearch()
  const [filter, setFilter] = useState<UserFilter>('all')
  const [list, setList] = useState<Loadable<List<AdminUser>>>({ kind: 'loading' })
  const [open, setOpen] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    listUsers(search.query, filter, 0, ctrl.signal)
      .then((d) => setList({ kind: 'ready', data: { items: d.users, total: d.total, pageSize: d.pageSize } }))
      .catch(() => !ctrl.signal.aborted && setList({ kind: 'error' }))
    return () => ctrl.abort()
  }, [search.query, filter])

  async function loadMore() {
    if (list.kind !== 'ready') return
    setMore(true)
    try {
      const d = await listUsers(search.query, filter, list.data.items.length)
      setList({ kind: 'ready', data: { ...list.data, items: [...list.data.items, ...d.users], total: d.total } })
    } catch {
      // The button stays so they can try again
    }
    setMore(false)
  }

  function replace(user: AdminUser) {
    setList((l) => (l.kind === 'ready' ? { kind: 'ready', data: { ...l.data, items: l.data.items.map((u) => (u.id === user.id ? user : u)) } } : l))
    onChanged()
  }

  function remove(id: string) {
    setList((l) => (l.kind === 'ready' ? { kind: 'ready', data: { ...l.data, items: l.data.items.filter((u) => u.id !== id), total: l.data.total - 1 } } : l))
    setOpen(null)
    onChanged()
  }

  const filters: { id: UserFilter; label: string }[] = [
    { id: 'all', label: 'Everyone' },
    { id: 'admins', label: 'Admins' },
    { id: 'suspended', label: 'Suspended' },
  ]

  return (
    <section id="people" className="settings-card" aria-labelledby="people-title">
      <header className="settings-card-head">
        <h2 id="people-title">People</h2>
        <p>Make people admins, suspend them, or delete their accounts. Suspended people can’t sign in and their agents stop working; their pages stay.</p>
      </header>

      {noEmail && <AddPerson />}

      <div className="admin-toolbar">
        <label className="visually-hidden" htmlFor="people-search">Search people</label>
        <input
          id="people-search"
          className="admin-search"
          type="search"
          placeholder="Search by name or email"
          value={search.input}
          onChange={(e) => search.setInput(e.target.value)}
          autoComplete="off"
        />
        <div className="admin-filters" role="group" aria-label="Show">
          {filters.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {list.kind === 'loading' && <p className="settings-muted" role="status">Loading people</p>}
      {list.kind === 'error' && <p className="auth-notice" role="alert">People could not be loaded. Reload to try again.</p>}
      {list.kind === 'ready' && (
        <>
          <p className="settings-muted admin-count" aria-live="polite">
            {list.data.total === 0 ? 'Nobody matches.' : `Showing ${list.data.items.length.toLocaleString('en')} of ${plural(list.data.total, 'person', 'people')}`}
          </p>
          {list.data.items.length > 0 && (
            <ul className="settings-list">
              {list.data.items.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  open={open === u.id}
                  onToggle={() => setOpen(open === u.id ? null : u.id)}
                  onUpdated={replace}
                  onDeleted={() => remove(u.id)}
                />
              ))}
            </ul>
          )}
          {list.data.items.length < list.data.total && (
            <div>
              <button type="button" className="button button-small button-quiet" onClick={loadMore} disabled={more}>
                {more ? 'Loading' : 'Show more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// A link that stays on screen once made, to copy and send however you like
function LinkResult({ link }: { link: SignUpLink }) {
  const until = new Date(link.expiresAt).toLocaleDateString('en', { dateStyle: 'medium' })
  return (
    <div className="admin-link-result" role="status">
      <p className="field-hint">
        {link.newAccount
          ? `Send this to ${link.email}. Opening it creates their account and asks them to choose a password.`
          : `Send this to ${link.email}. Opening it signs them in and asks for a new password.`}{' '}
        It works once, until {until}.
      </p>
      <CopyCommand command={link.link} label="Copy link" plain />
    </div>
  )
}

// On a server without email, how new people get an account: an admin makes a link and passes it on
function AddPerson() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [made, setMade] = useState<SignUpLink | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      setMade(await createSignUpLink(email))
      setEmail('')
    } catch (err) {
      setProblem(errorText(err, 'The link could not be made. Try again.'))
    }
    setBusy(false)
  }

  return (
    <div className="admin-add-person">
      <form className="admin-add-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="add-person-email">Add someone</label>
          <input
            id="add-person-email"
            className="admin-input"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setProblem(null) }}
            placeholder="name@example.com"
            autoComplete="off"
            aria-invalid={Boolean(problem) || undefined}
            aria-describedby="add-person-hint"
          />
        </div>
        <button type="submit" className="button button-small" disabled={busy || !email.trim()}>
          {busy ? 'Making link' : 'Make sign-up link'}
        </button>
      </form>
      <p id="add-person-hint" className="field-hint">
        This server doesn’t send email, so you pass the link on yourself. They can sign up whatever the sign-up policy says.
      </p>
      {problem && <p className="auth-notice" role="alert">{problem}</p>}
      {made && <LinkResult link={made} />}
    </div>
  )
}

function Badges({ user }: { user: AdminUser }) {
  return (
    <>
      {user.isYou && <span className="settings-you">You</span>}
      {user.isAdmin && <span className="admin-badge">Admin</span>}
      {user.suspended && <span className="admin-badge admin-badge-bad">Suspended</span>}
    </>
  )
}

function UserRow({ user: u, open, onToggle, onUpdated, onDeleted }: {
  user: AdminUser
  open: boolean
  onToggle: () => void
  onUpdated: (u: AdminUser) => void
  onDeleted: () => void
}) {
  const display = u.name ?? u.email
  const panelId = `user-${u.id}`
  return (
    <li className="settings-row admin-row" data-open={open || undefined} data-suspended={u.suspended || undefined}>
      {u.avatarUrl ? (
        <img className="settings-avatar" src={u.avatarUrl} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="settings-avatar" aria-hidden="true">{display.slice(0, 1).toUpperCase()}</span>
      )}
      <span className="settings-who">
        <strong>
          <span className="admin-name">{display}</span>
          <Badges user={u} />
        </strong>
        {u.name && <span>{u.email}</span>}
      </span>
      <span className="settings-meta">
        {plural(u.pageCount, 'page')}, {u.lastSeenAt ? `seen ${timeAgo(u.lastSeenAt)}` : 'not seen yet'}
      </span>
      <span className="settings-actions">
        <button type="button" className="button button-small button-quiet" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          {open ? 'Close' : 'Manage'}
        </button>
      </span>
      {open && <UserPanel id={panelId} user={u} onUpdated={onUpdated} onDeleted={onDeleted} />}
    </li>
  )
}

function UserPanel({ id, user: u, onUpdated, onDeleted }: { id: string; user: AdminUser; onUpdated: (u: AdminUser) => void; onDeleted: () => void }) {
  const config = useConfig()
  const [resetLink, setResetLink] = useState<SignUpLink | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'suspend' | 'delete' | 'demote' | null>(null)

  async function change(patch: { admin?: boolean; suspended?: boolean }, fallback: string) {
    setBusy(true)
    setProblem(null)
    try {
      onUpdated(await updateUser(u.id, patch))
      setConfirm(null)
    } catch (err) {
      setProblem(errorText(err, fallback))
    }
    setBusy(false)
  }

  async function makeResetLink() {
    setBusy(true)
    setProblem(null)
    try {
      setResetLink(await createSignUpLink(u.email))
    } catch (err) {
      setProblem(errorText(err, 'The link could not be made. Try again.'))
    }
    setBusy(false)
  }

  return (
    <div id={id} className="admin-panel">
      <dl className="admin-facts">
        <div>
          <dt>Joined</dt>
          <dd>{new Date(u.createdAt).toLocaleDateString('en', { dateStyle: 'medium' })}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{u.lastSeenAt ? timeAgo(u.lastSeenAt) : 'Not yet'}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{u.pageCount.toLocaleString('en')}</dd>
        </div>
        <div className="admin-facts-wide">
          <dt>Organizations</dt>
          <dd>{u.organizations.length ? u.organizations.map((o) => `${o.name} (${o.role})`).join(', ') : 'None, personal workspace only'}</dd>
        </div>
      </dl>

      {problem && <p className="auth-notice" role="alert">{problem}</p>}

      {confirm === null && (
        <div className="admin-panel-actions">
          {u.isAdmin ? (
            <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => setConfirm('demote')}>
              Remove admin
            </button>
          ) : (
            <button type="button" className="button button-small button-quiet" disabled={busy || u.suspended} onClick={() => change({ admin: true }, 'They could not be made an admin.')}>
              Make admin
            </button>
          )}
          {!u.isYou &&
            (u.suspended ? (
              <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => change({ suspended: false }, 'They could not be unsuspended.')}>
                Unsuspend
              </button>
            ) : (
              <button type="button" className="button button-small button-quiet" disabled={busy} onClick={() => setConfirm('suspend')}>
                Suspend
              </button>
            ))}
          {config?.emailSignIn === false && !u.suspended && (
            <button type="button" className="button button-small button-quiet" disabled={busy} onClick={makeResetLink}>
              Password reset link
            </button>
          )}
          {!u.isYou && (
            <button type="button" className="auth-reset admin-delete-link" onClick={() => setConfirm('delete')}>
              Delete account
            </button>
          )}
          {u.isYou && <p className="field-hint">To delete your own account, use <Link className="text-link" to="/settings#delete">Account settings</Link>.</p>}
        </div>
      )}

      {resetLink && confirm === null && <LinkResult link={resetLink} />}

      {confirm === 'demote' && (
        <Confirm
          text={u.isYou ? 'You will lose access to this page right away.' : `${u.name ?? u.email} will no longer be able to open the admin area.`}
          action="Remove admin"
          busy={busy}
          onConfirm={() => change({ admin: false }, 'Admin access could not be removed.')}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'suspend' && (
        <Confirm
          text="They are signed out everywhere and their connected agents stop working. Their pages stay where they are. You can undo this."
          action="Suspend"
          busy={busy}
          onConfirm={() => change({ suspended: true }, 'They could not be suspended.')}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'delete' && <DeleteUser user={u} onDeleted={onDeleted} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

function Confirm({ text, action, busy, onConfirm, onCancel }: { text: ReactNode; action: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="admin-confirm" role="group" aria-label={`Confirm: ${action}`}>
      <p>{text}</p>
      <div className="admin-panel-actions">
        <button type="button" className="button button-small button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working' : action}
        </button>
        <button type="button" className="auth-reset" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function DeleteUser({ user: u, onDeleted, onCancel }: { user: AdminUser; onDeleted: () => void; onCancel: () => void }) {
  const [preview, setPreview] = useState<Loadable<UserDeletionPreview>>({ kind: 'loading' })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const matches = typed.trim().toLowerCase() === u.email
  const inputId = `delete-${u.id}`

  useEffect(() => {
    let active = true
    getUserDeletion(u.id)
      .then((data) => active && setPreview({ kind: 'ready', data }))
      .catch(() => active && setPreview({ kind: 'error' }))
    return () => { active = false }
  }, [u.id])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      await deleteUser(u.id, typed)
      onDeleted()
    } catch (err) {
      setProblem(errorText(err, 'The account could not be deleted. Try again.'))
      setBusy(false)
    }
  }

  if (preview.kind === 'loading') return <p className="settings-muted" role="status">Checking what would be deleted</p>
  if (preview.kind === 'error') return <p className="auth-notice" role="alert">This could not be checked. Close and try again.</p>
  const p = preview.data

  if (p.blockedBy.length) {
    return (
      <div className="admin-confirm">
        <p>
          {u.email} is the only owner of {p.blockedBy.map((o) => o.name).join(', ')}, which other people are in. Make someone else an owner there, or delete
          {p.blockedBy.length === 1 ? ' that organization' : ' those organizations'} below, then try again.
        </p>
        <div className="admin-panel-actions">
          <button type="button" className="auth-reset" onClick={onCancel}>Back</button>
        </div>
      </div>
    )
  }

  return (
    <form className="admin-confirm" onSubmit={onSubmit}>
      <p>
        This deletes {u.email}
        {p.pageCount ? ` and the ${plural(p.pageCount, 'page')} they own` : ''}
        {p.deletesOrganizations.length ? `, along with ${p.deletesOrganizations.join(', ')}, which only they are in` : ''}. It can’t be undone.
      </p>
      <div className="field">
        <label htmlFor={inputId}>
          Type <strong>{u.email}</strong> to confirm
        </label>
        <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {problem && <p className="auth-notice" role="alert">{problem}</p>}
      <div className="admin-panel-actions">
        <button type="submit" className="button button-small button-danger" disabled={!matches || busy}>
          {busy ? 'Deleting' : 'Delete account'}
        </button>
        <button type="button" className="auth-reset" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function OrganizationsSection({ onChanged }: { onChanged: () => void }) {
  const search = useSearch()
  const [list, setList] = useState<Loadable<List<AdminOrganization>>>({ kind: 'loading' })
  const [open, setOpen] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    listOrganizations(search.query, 0, ctrl.signal)
      .then((d) => setList({ kind: 'ready', data: { items: d.organizations, total: d.total, pageSize: d.pageSize } }))
      .catch(() => !ctrl.signal.aborted && setList({ kind: 'error' }))
    return () => ctrl.abort()
  }, [search.query])

  async function loadMore() {
    if (list.kind !== 'ready') return
    setMore(true)
    try {
      const d = await listOrganizations(search.query, list.data.items.length)
      setList({ kind: 'ready', data: { ...list.data, items: [...list.data.items, ...d.organizations], total: d.total } })
    } catch {
      // The button stays so they can try again
    }
    setMore(false)
  }

  function remove(id: string) {
    setList((l) => (l.kind === 'ready' ? { kind: 'ready', data: { ...l.data, items: l.data.items.filter((o) => o.id !== id), total: l.data.total - 1 } } : l))
    setOpen(null)
    onChanged()
  }

  return (
    <section id="organizations" className="settings-card" aria-labelledby="orgs-title">
      <header className="settings-card-head">
        <h2 id="orgs-title">Organizations</h2>
        <p>Every organization on this instance. Deleting one removes its pages and memberships; the people in it keep their accounts.</p>
      </header>

      <div className="admin-toolbar">
        <label className="visually-hidden" htmlFor="orgs-search">Search organizations</label>
        <input
          id="orgs-search"
          className="admin-search"
          type="search"
          placeholder="Search by name or address"
          value={search.input}
          onChange={(e) => search.setInput(e.target.value)}
          autoComplete="off"
        />
      </div>

      {list.kind === 'loading' && <p className="settings-muted" role="status">Loading organizations</p>}
      {list.kind === 'error' && <p className="auth-notice" role="alert">Organizations could not be loaded. Reload to try again.</p>}
      {list.kind === 'ready' && list.data.total === 0 && (
        <p className="settings-muted">{search.query ? 'Nothing matches.' : 'Nobody has created an organization yet.'}</p>
      )}
      {list.kind === 'ready' && list.data.items.length > 0 && (
        <ul className="settings-list">
          {list.data.items.map((o) => (
            <li key={o.id} className="settings-row admin-row" data-open={open === o.id || undefined}>
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">{o.name.slice(0, 1).toUpperCase()}</span>
              <span className="settings-who">
                <strong>
                  <span className="admin-name">{o.name}</span>
                </strong>
                <span>
                  {o.slug}
                  {o.owners.length ? `, owned by ${o.owners.map((w) => w.name ?? w.email).join(', ')}` : ', no owner'}
                </span>
              </span>
              <span className="settings-meta">
                {plural(o.memberCount, 'member')}, {plural(o.pageCount, 'page')}
              </span>
              <span className="settings-actions">
                <button
                  type="button"
                  className="button button-small button-quiet"
                  aria-expanded={open === o.id}
                  onClick={() => setOpen(open === o.id ? null : o.id)}
                >
                  {open === o.id ? 'Cancel' : 'Delete'}
                </button>
              </span>
              {open === o.id && <DeleteOrganization org={o} onDeleted={() => remove(o.id)} onCancel={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
      {list.kind === 'ready' && list.data.items.length < list.data.total && (
        <div>
          <button type="button" className="button button-small button-quiet" onClick={loadMore} disabled={more}>
            {more ? 'Loading' : 'Show more'}
          </button>
        </div>
      )}
    </section>
  )
}

function DeleteOrganization({ org, onDeleted, onCancel }: { org: AdminOrganization; onDeleted: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const inputId = `delete-org-${org.id}`

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      await deleteOrganization(org.id, typed)
      onDeleted()
    } catch (err) {
      setProblem(errorText(err, 'The organization could not be deleted. Try again.'))
      setBusy(false)
    }
  }

  return (
    <form className="admin-panel admin-confirm" onSubmit={onSubmit}>
      <p>
        This deletes {org.name}{org.pageCount ? ` and its ${plural(org.pageCount, 'page')}` : ''}. The people in it keep their accounts and personal pages. It
        can’t be undone.
      </p>
      <div className="field">
        <label htmlFor={inputId}>
          Type <strong>{org.slug}</strong> to confirm
        </label>
        <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {problem && <p className="auth-notice" role="alert">{problem}</p>}
      <div className="admin-panel-actions">
        <button type="submit" className="button button-small button-danger" disabled={typed.trim().toLowerCase() !== org.slug || busy}>
          {busy ? 'Deleting' : 'Delete organization'}
        </button>
        <button type="button" className="auth-reset" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

const POLICIES: { id: SignupPolicy; label: string; hint: string }[] = [
  { id: 'open', label: 'Anyone', hint: 'Anyone who can reach this server can create an account.' },
  { id: 'domains', label: 'Email domains', hint: 'Only addresses at the domains you list, for example your company’s.' },
  { id: 'invite-only', label: 'Invited people only', hint: 'Nobody can sign up on their own.' },
]

function SignupSection({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Loadable<InstanceSettings>>({ kind: 'loading' })
  const [policy, setPolicy] = useState<SignupPolicy>('open')
  const [domains, setDomains] = useState('')
  const [instanceName, setInstanceName] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string; field?: string } | null>(null)

  function load(data: InstanceSettings) {
    setSettings({ kind: 'ready', data })
    setPolicy(data.signupPolicy)
    setDomains(data.allowedDomains.join('\n'))
    setInstanceName(data.instanceName ?? '')
  }

  useEffect(() => {
    let active = true
    getSettings()
      .then((data) => active && load(data))
      .catch(() => active && setSettings({ kind: 'error' }))
    return () => { active = false }
  }, [])

  async function run(action: () => Promise<InstanceSettings>, ok: string) {
    setSaving(true)
    setStatus(null)
    try {
      load(await action())
      setStatus({ tone: 'ok', text: ok })
      onChanged()
    } catch (err) {
      const field = err instanceof Error && 'field' in err ? (err.field as string | undefined) : undefined
      setStatus({ tone: 'bad', text: errorText(err, 'The settings could not be saved. Try again.'), field })
    }
    setSaving(false)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const list = domains.split(/[\s,]+/).filter(Boolean)
    void run(() => saveSettings({ signupPolicy: policy, allowedDomains: list, instanceName }), 'Saved. New sign-ups follow this right away.')
  }

  return (
    <section id="signup" className="settings-card" aria-labelledby="signup-title">
      <header className="settings-card-head">
        <h2 id="signup-title">Sign-up</h2>
        <p>Who can create an account. People invited to an organization or a page can always join, and existing accounts can always sign in.</p>
      </header>

      {settings.kind === 'loading' && <p className="settings-muted" role="status">Loading settings</p>}
      {settings.kind === 'error' && <p className="auth-notice" role="alert">The settings could not be loaded. Reload to try again.</p>}
      {settings.kind === 'ready' && (
        <form className="settings-form" onSubmit={onSubmit} noValidate>
          {!settings.data.updatedAt && <p className="admin-source">Not saved yet, so anyone who can reach this server can sign up.</p>}

          <fieldset className="admin-policies">
            <legend className="settings-label">Who can sign up</legend>
            {POLICIES.map((p) => (
              <label key={p.id} className="admin-policy">
                <input type="radio" name="signup-policy" value={p.id} checked={policy === p.id} onChange={() => { setPolicy(p.id); setStatus(null) }} />
                <span>
                  <strong>{p.label}</strong>
                  <span>{p.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {policy === 'domains' && (
            <div className="field">
              <label htmlFor="signup-domains">Email domains</label>
              <textarea
                id="signup-domains"
                className="admin-textarea"
                rows={3}
                value={domains}
                onChange={(e) => { setDomains(e.target.value); setStatus(null) }}
                placeholder={'example.com\nexample.org'}
                spellCheck={false}
                aria-invalid={status?.field === 'allowedDomains' || undefined}
                aria-describedby="signup-domains-hint"
              />
              <p id="signup-domains-hint" className="field-hint">One per line, or separated by commas. Subdomains need their own line.</p>
            </div>
          )}

          <div className="field">
            <label htmlFor="instance-name">Instance name</label>
            <input
              id="instance-name"
              className="admin-input"
              value={instanceName}
              onChange={(e) => { setInstanceName(e.target.value); setStatus(null) }}
              maxLength={60}
              placeholder="Acme pages"
              aria-invalid={status?.field === 'instanceName' || undefined}
              aria-describedby="instance-name-hint"
            />
            <p id="instance-name-hint" className="field-hint">Optional. Shown next to the logo for everyone who signs in.</p>
          </div>

          <div className="admin-panel-actions">
            <button type="submit" className="button button-small" disabled={saving}>
              {saving ? 'Saving' : 'Save'}
            </button>
          </div>
          <p className="field-hint" data-tone={status?.tone} aria-live="polite" role={status?.tone === 'bad' ? 'alert' : undefined}>
            {status?.text ?? (settings.data.updatedAt ? `Last saved ${timeAgo(settings.data.updatedAt)}.` : '')}
          </p>
        </form>
      )}
    </section>
  )
}
