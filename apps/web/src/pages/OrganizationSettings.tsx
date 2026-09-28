import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  fetchMe,
  getOrganization,
  inviteMember,
  listOrganizationTokens,
  removeMember,
  renameOrganization,
  revokeInvitation,
  revokeOrganizationToken,
  setMemberRole,
  setRequireTwoFactor,
  type InviteRole,
  type Me,
  type Organization,
  type OrganizationAccessToken,
  type OrganizationDetails,
  type OrganizationMember,
  type Role,
} from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { ExportSection } from '../components/ExportSection'
import { WebhooksSection } from '../components/Webhooks'
import '../components/SignInSecurity.css'
import { APP_HOST } from '../config'
import { RetentionSection } from '../ee/Retention'
import { expiryText, timeAgo } from '../time'
import { useConfig } from '../useConfig'
import { useMe } from '../useMe'
import { chooseWorkspace } from '../workspace'
import { LoadError, Loading } from './Status'
import './Workspace.css'
import './Settings.css'

// Enterprise, self-hosted only: its code stays out of the bundle everywhere else
const AuditLogSection = lazy(() => import('../ee/AuditLog.tsx').then((m) => ({ default: m.AuditLogSection })))

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

// Roles a person with `actor` role may hand out, and whose holders they may manage
function assignable(actor: Role): Role[] {
  if (actor === 'owner') return ['owner', 'admin', 'member']
  if (actor === 'admin') return ['admin', 'member']
  return []
}

const canManage = (actor: Role, target: Role) => assignable(actor).includes(target)
const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

// One organization's settings: its name, who is in it, and invitations. Separate from account
// settings, and from the server admin area.
export function OrganizationSettings() {
  const state = useMe()
  const { slug = '' } = useParams()

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  const org = state.me.organizations.find((o) => o.slug === slug)
  if (!org) return <NotAMember me={state.me} />
  return <Page key={org.id} initial={state.me} org={org} />
}

function NotAMember({ me }: { me: Me }) {
  useEffect(() => {
    document.title = 'Organization not found | The Artifact'
    return () => {
      document.title = 'The Artifact'
    }
  }, [])
  return (
    <div className="auth">
      <AccountHeader me={me} workspace="Personal" />
      <main id="main" className="app-main settings">
        <div className="app-title">
          <h1>Organization not found</h1>
          <p>You are not in an organization at this address. Ask one of its owners to invite you.</p>
        </div>
        <Link className="button button-small button-quiet" to="/app">
          Go to your pages
        </Link>
      </main>
    </div>
  )
}

function Page({ initial, org }: { initial: Me; org: Organization }) {
  const navigate = useNavigate()
  const selfHosted = useConfig()?.selfHosted === true
  // Whether the audit log answered that it is on (an Enterprise license); its rail link waits for that
  const [auditOn, setAuditOn] = useState(false)
  const [me, setMe] = useState(initial)
  const [details, setDetails] = useState<Loadable<OrganizationDetails>>({ kind: 'loading' })
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const current = me.organizations.find((o) => o.id === org.id) ?? org
  // Version retention is an enterprise feature for self-hosted installs (ee/Retention.tsx)
  const retention = useConfig()?.selfHosted === true && current.role !== 'member' && !current.blocked
  const refreshMe = () =>
    fetchMe()
      .then((m) => m && setMe(m))
      .catch(() => {})

  // Opening an organization's settings also switches to it, so the header says where you are
  useEffect(() => {
    chooseWorkspace(org.id)
  }, [org.id])

  useEffect(() => {
    document.title = `${current.name} settings | The Artifact`
    return () => {
      document.title = 'The Artifact'
    }
  }, [current.name])

  useEffect(() => {
    let active = true
    getOrganization(org.id)
      .then((data) => active && setDetails({ kind: 'ready', data }))
      .catch(() => active && setDetails({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [org.id])

  async function run(action: () => Promise<OrganizationDetails | null>, fallback: string) {
    setProblem(null)
    try {
      const data = await action()
      if (data) setDetails({ kind: 'ready', data })
      void refreshMe()
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

  const sections = [
    { id: 'general', label: 'General' },
    { id: 'members', label: 'Members' },
    ...(current.role === 'member' ? [] : [{ id: 'tokens', label: 'Access tokens' }]),
    ...(current.role === 'member' || current.blocked ? [] : [{ id: 'webhooks', label: 'Webhooks' }]),
    ...(retention ? [{ id: 'retention', label: 'Version history' }] : []),
    ...(current.role === 'owner' && !current.blocked ? [{ id: 'export', label: 'Export data' }] : []),
    ...(auditOn && current.role !== 'member' ? [{ id: 'audit', label: 'Audit log' }] : []),
  ]

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={current.name} />
      <main id="main" className="app-main settings">
        <div className="app-title">
          <h1>{current.name} settings</h1>
          <p>
            The organization’s name and who is in it. Your role: {ROLE_LABEL[current.role]}.{' '}
            <Link className="text-link" to="/settings">
              Account settings
            </Link>{' '}
            are separate.
          </p>
        </div>

        <div className="settings-layout">
          <nav className="settings-rail" aria-label="Organization settings sections">
            <ol>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.label}</a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="settings-sections">
            {current.blocked ? (
              <section className="settings-card" aria-labelledby="blocked-title">
                <header className="settings-card-head">
                  <h2 id="blocked-title">Two-factor sign-in required</h2>
                  <p>
                    {current.name} requires two-factor sign-in. Add a passkey or an authenticator app to your account to use it. Your agents and access tokens
                    keep working in the meantime.
                  </p>
                </header>
                <div className="settings-signout">
                  <Link className="button button-small" to="/settings#security">
                    Set up two-factor sign-in
                  </Link>
                  {confirming === 'leave' ? (
                    <>
                      <button type="button" className="button button-small button-danger" onClick={leave}>
                        Leave {current.name}
                      </button>
                      <button type="button" className="auth-reset" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="auth-reset" onClick={() => setConfirming('leave')}>
                      Leave {current.name}
                    </button>
                  )}
                </div>
                {problem && (
                  <p className="auth-notice" role="alert">
                    {problem}
                  </p>
                )}
              </section>
            ) : details.kind !== 'ready' ? (
              <section className="settings-card">
                {details.kind === 'loading' ? (
                  <p className="settings-muted" role="status">
                    Loading {current.name}
                  </p>
                ) : (
                  <p className="auth-notice" role="alert">
                    The organization could not be loaded. Reload to try again.
                  </p>
                )}
              </section>
            ) : (
              <Sections
                me={me}
                d={details.data}
                problem={problem}
                confirming={confirming}
                setConfirming={setConfirming}
                run={run}
                leave={leave}
                onDetails={(data) => {
                  setDetails({ kind: 'ready', data })
                  void refreshMe()
                }}
              />
            )}
            {current.role !== 'member' && !current.blocked && <TokensSection org={current} me={me} />}
            {current.role !== 'member' && !current.blocked && <WebhooksSection workspace={current.id} name={current.name} />}
            {retention && <RetentionSection orgId={current.id} orgName={current.name} />}
            {current.role === 'owner' && !current.blocked && <ExportSection organization={{ id: current.id, name: current.name }} />}
            {current.role !== 'member' && !current.blocked && selfHosted && (
              <Suspense fallback={null}>
                <AuditLogSection org={current} onAvailable={setAuditOn} />
              </Suspense>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function Sections({
  me,
  d,
  problem,
  confirming,
  setConfirming,
  run,
  leave,
  onDetails,
}: {
  me: Me
  d: OrganizationDetails
  problem: string | null
  confirming: string | null
  setConfirming: (id: string | null) => void
  run: (action: () => Promise<OrganizationDetails | null>, fallback: string) => Promise<boolean>
  leave: () => void
  onDetails: (d: OrganizationDetails) => void
}) {
  const manager = d.role !== 'member'
  const owners = d.members.filter((m) => m.role === 'owner').length
  const soleOwner = d.role === 'owner' && owners === 1

  return (
    <>
      <section id="general" className="settings-card" aria-labelledby="general-title">
        <header className="settings-card-head">
          <h2 id="general-title">General</h2>
          <p>{manager ? 'What people see when they join.' : 'Owners and admins can rename the organization.'}</p>
        </header>
        {manager ? (
          <RenameForm details={d} onRenamed={onDetails} />
        ) : (
          <div className="field">
            <span className="settings-label">Organization name</span>
            <p className="settings-value">{d.name}</p>
          </div>
        )}
        <div className="field">
          <span className="settings-label">Address</span>
          <p className="settings-value">
            {APP_HOST}/{d.slug}
          </p>
        </div>
        <TwoFactorSetting me={me} details={d} onChanged={onDetails} />
      </section>

      <section id="members" className="settings-card" aria-labelledby="members-title">
        <header className="settings-card-head">
          <h2 id="members-title">Members</h2>
          <p>
            {d.members.length === 1 ? '1 member' : `${d.members.length} members`}.
            {manager ? ' Owners and admins can invite people and change roles.' : ' Owners and admins manage who is in it.'}{' '}
            <Link className="text-link" to="/docs/organizations#roles">
              What each role can do
            </Link>
          </p>
        </header>

        {problem && (
          <p className="auth-notice" role="alert">
            {problem}
          </p>
        )}
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
              onRole={(role) => run(() => setMemberRole(d.id, m.id, role), 'The role could not be changed. Try again.')}
              onRemove={() => (m.id === me.id ? leave() : run(() => removeMember(d.id, m.id), 'They could not be removed. Try again.'))}
            />
          ))}
        </ul>
        {soleOwner && d.members.length > 1 && <p className="field-hint">You are the only owner. To leave, make someone else an owner first.</p>}

        {manager && (
          <>
            <h3 className="settings-subhead">Invite people</h3>
            <InviteForm details={d} myRole={d.role} onInvited={onDetails} />
            {d.invitations.length > 0 && (
              <>
                <h3 className="settings-subhead">Pending invitations</h3>
                <ul className="settings-list">
                  {d.invitations.map((i) => (
                    <li key={i.id} className="settings-row">
                      <span className="settings-avatar settings-avatar-pending" aria-hidden="true">
                        {i.email.slice(0, 1).toUpperCase()}
                      </span>
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
                          onClick={() => run(async () => (await inviteMember(d.id, i.email, i.role)).organization, 'The invitation could not be sent again.')}
                        >
                          Resend
                        </button>
                        <button
                          type="button"
                          className="button button-small button-quiet"
                          onClick={() => run(() => revokeInvitation(d.id, i.id), 'The invitation could not be revoked. Try again.')}
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
    </>
  )
}

// Owners and admins see every member's access tokens for the organization and can revoke any of
// them, so a token that leaks can be stopped without waiting for the person who made it
function TokensSection({ org, me }: { org: Organization; me: Me }) {
  const [tokens, setTokens] = useState<Loadable<OrganizationAccessToken[]>>({ kind: 'loading' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listOrganizationTokens(org.id)
      .then((data) => active && setTokens({ kind: 'ready', data }))
      .catch(() => active && setTokens({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [org.id])

  async function revoke(t: OrganizationAccessToken) {
    setProblem(null)
    try {
      await revokeOrganizationToken(org.id, t.id)
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
          Tokens members made to publish to {org.name} from CI and scripts. Revoking one stops it at once. People make their own in{' '}
          <Link className="text-link" to="/settings#tokens">
            Account settings
          </Link>
          .
        </p>
      </header>
      {tokens.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading access tokens
        </p>
      )}
      {tokens.kind === 'error' && (
        <p className="auth-notice" role="alert">
          The access tokens could not be loaded. Reload to try again.
        </p>
      )}
      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}
      {tokens.kind === 'ready' && tokens.data.length === 0 && <p className="settings-muted">Nobody has an access token for {org.name}.</p>}
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
                  {t.owner.id === me.id ? 'Yours' : `By ${t.owner.name ?? t.owner.email}`}, created {timeAgo(t.createdAt)}
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

function MemberRow({
  member: m,
  self,
  myRole,
  lastOwner,
  confirming,
  onConfirm,
  onRole,
  onRemove,
}: {
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
        <span className="settings-avatar" aria-hidden="true">
          {display.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="settings-who">
        <strong>
          {display}
          {self && <span className="settings-you">You</span>}
          <span className="two-factor-badge" data-on={m.twoFactor || undefined}>
            {m.twoFactor ? '2FA on' : 'No 2FA'}
          </span>
        </strong>
        {m.name && <span>{m.email}</span>}
      </span>
      <span className="settings-meta">
        {editable ? (
          <select className="settings-select" value={m.role} aria-label={`Role for ${display}`} onChange={(e) => onRole(e.target.value as Role)}>
            {assignable(myRole).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
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
              <button type="button" className="auth-reset" onClick={() => onConfirm(false)}>
                Cancel
              </button>
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

// Owners and admins turn the requirement on; they need a second factor themselves first
function TwoFactorSetting({ me, details: d, onChanged }: { me: Me; details: OrganizationDetails; onChanged: (d: OrganizationDetails) => void }) {
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const manager = d.role !== 'member'
  const without = d.members.filter((m) => !m.twoFactor).length

  async function toggle(on: boolean) {
    setSaving(true)
    setProblem(null)
    try {
      onChanged(await setRequireTwoFactor(d.id, on))
    } catch (err) {
      setProblem(errorText(err, 'The setting could not be saved. Try again.'))
    }
    setSaving(false)
  }

  if (!manager) {
    return (
      <div className="field">
        <span className="settings-label">Two-factor sign-in</span>
        <p className="settings-value">{d.requireTwoFactor ? 'Required for every member' : 'Not required'}</p>
      </div>
    )
  }

  return (
    <div className="field">
      <label className="settings-check">
        <input type="checkbox" checked={Boolean(d.requireTwoFactor)} disabled={saving} onChange={(e) => toggle(e.target.checked)} />
        <span>Require two-factor sign-in</span>
      </label>
      <p className="field-hint" data-tone={problem ? 'bad' : undefined} aria-live="polite">
        {problem ??
          (d.requireTwoFactor
            ? without
              ? `${without === 1 ? '1 member hasn’t' : `${without} members haven’t`} set it up. Until they do, they can’t use ${d.name} in the app; their agents and access tokens keep working.`
              : 'Every member signs in with a passkey or an authenticator app.'
            : me.twoFactor
              ? 'Members without a passkey or an authenticator app are asked to add one, and can’t use the organization in the app until they do.'
              : 'Add a passkey or an authenticator app to your own account first, in account settings.')}
      </p>
    </div>
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
          <input
            id="org-rename"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setStatus(null)
            }}
            minLength={2}
            maxLength={60}
            required
            aria-describedby="org-rename-status"
          />
          <button type="submit" className="button button-small" disabled={saving || value.trim() === details.name || value.trim().length < 2}>
            {saving ? 'Saving' : 'Rename'}
          </button>
        </div>
        <p id="org-rename-status" className="field-hint" data-tone={status?.tone} aria-live="polite">
          {status?.text ?? ''}
        </p>
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
  const noEmail = useConfig()?.emailSignIn === false

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
          : noEmail
            ? { tone: 'ok', text: `Invitation made. Send ${email.trim().toLowerCase()} this link; they can create their account from it:`, link: sent.link }
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
      <label className="visually-hidden" htmlFor="invite-email">
        Email address
      </label>
      <input
        id="invite-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@company.com"
        autoComplete="off"
        required
      />
      <label className="visually-hidden" htmlFor="invite-role">
        Role
      </label>
      <select id="invite-role" className="settings-select" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <button type="submit" className="button button-small" disabled={sending || !email.trim()}>
        {sending ? (noEmail ? 'Making link' : 'Sending') : noEmail ? 'Make invite link' : 'Send invite'}
      </button>
      <p className="field-hint settings-invite-hint" data-tone={result?.tone} aria-live="polite">
        {result
          ? result.text
          : noEmail
            ? `You get a link to send them yourself; this server doesn’t send email. It works for 7 days.`
            : `They get an email with a link to join ${details.name}. It works for 7 days.`}
        {result?.link && <code className="settings-link">{result.link}</code>}
      </p>
    </form>
  )
}
