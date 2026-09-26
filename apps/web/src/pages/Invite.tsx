import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { acceptInvitation, ApiError, declineInvitation, getInvitation, logout, type Invitation } from '../api'
import { Wordmark } from '../components/Wordmark'
import { LOGIN_URL, SIGNUP_URL } from '../config'
import { timeAgo } from '../time'
import { chooseWorkspace } from '../workspace'
import './Auth.css'
import './Workspace.css'
import './Invite.css'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; invitation: Invitation }
  | { kind: 'declined'; organization: string }
  | { kind: 'error'; message: string }

const ROLE_TEXT = { admin: 'an admin', member: 'a member' } as const

// Where an invitation email lands: explains the invitation, then signs in and accepts
export function Invite() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Invitation | The Artifact'
    return () => { document.title = 'The Artifact' }
  }, [])

  useEffect(() => {
    let active = true
    getInvitation(token)
      .then((invitation) => active && setState({ kind: 'ready', invitation }))
      .catch((err) =>
        active &&
        setState({
          kind: 'error',
          message: err instanceof ApiError && err.status === 404 ? err.message : 'The invitation could not be loaded. Reload to try again.',
        }),
      )
    return () => { active = false }
  }, [token])

  const next = `?next=${encodeURIComponent(`/invite/${token}`)}`

  async function accept() {
    setBusy(true)
    setProblem(null)
    try {
      const org = await acceptInvitation(token)
      chooseWorkspace(org.id)
      navigate('/app', { replace: true })
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The invitation could not be accepted. Try again.')
      setBusy(false)
    }
  }

  async function decline(organization: string) {
    setBusy(true)
    try {
      await declineInvitation(token)
      setState({ kind: 'declined', organization })
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The invitation could not be declined. Try again.')
    }
    setBusy(false)
  }

  async function switchAccount() {
    setBusy(true)
    await logout()
    navigate(`${LOGIN_URL}${next}`)
  }

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box invite" aria-labelledby="invite-title" aria-busy={state.kind === 'loading'}>
          {state.kind === 'loading' && <p className="auth-lede" role="status">Loading the invitation</p>}

          {state.kind === 'error' && (
            <>
              <h1 id="invite-title">This invitation can't be used</h1>
              <p className="auth-lede">{state.message} Ask the person who invited you to send a new one.</p>
              <Link className="text-link" to="/app">Go to your pages</Link>
            </>
          )}

          {state.kind === 'declined' && (
            <div role="status">
              <h1 id="invite-title">Invitation declined</h1>
              <p className="auth-lede">You did not join {state.organization}. You can close this tab.</p>
            </div>
          )}

          {state.kind === 'ready' && body(state.invitation)}
        </section>
      </main>
    </div>
  )

  function body(inv: Invitation) {
    const org = inv.organization.name
    const others = inv.organization.memberCount
    const diagram = (
      <div className="invite-diagram" aria-hidden="true">
        <span className="invite-node">
          <span className="invite-dot">1</span>
          <span className="invite-label">{inv.email}</span>
        </span>
        <span className="consent-wire" />
        <span className="invite-node invite-node-org">
          <span className="invite-dot">2</span>
          <span className="invite-label">{org}</span>
        </span>
      </div>
    )
    const intro = (
      <>
        <h1 id="invite-title">Join {org}</h1>
        <p className="auth-lede">
          {inv.invitedBy ?? 'Someone'} invited you to join as {ROLE_TEXT[inv.role]}. You will see the pages people in {org} publish
          with their agents. {others === 1 ? '1 person is' : `${others} people are`} in it now.
        </p>
      </>
    )

    if (inv.expired) {
      return (
        <>
          {diagram}
          <h1 id="invite-title">This invitation has expired</h1>
          <p className="auth-lede">
            The invitation to {org} expired {timeAgo(inv.expiresAt)}. Ask {inv.invitedBy ?? 'the person who invited you'} to
            send a new one.
          </p>
        </>
      )
    }

    if (inv.alreadyMember) {
      return (
        <>
          {diagram}
          <h1 id="invite-title">You are already in {org}</h1>
          <p className="auth-lede">Nothing else to do. Your pages in {org} are waiting.</p>
          <div className="onboarding-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                chooseWorkspace(inv.organization.id)
                navigate('/app')
              }}
            >
              Go to {org}
            </button>
          </div>
        </>
      )
    }

    if (!inv.signedInAs) {
      return (
        <>
          {diagram}
          {intro}
          <p className="invite-note">
            Log in or sign up with <strong>{inv.email}</strong> to accept.
          </p>
          <div className="onboarding-actions">
            <Link className="button" to={`${LOGIN_URL}${next}`}>Log in to accept</Link>
            <Link className="text-link" to={`${SIGNUP_URL}${next}`}>Create an account</Link>
          </div>
        </>
      )
    }

    if (inv.signedInAs !== inv.email) {
      return (
        <>
          {diagram}
          {intro}
          <div className="invite-mismatch" role="alert">
            <p>
              This invitation is for <strong>{inv.email}</strong>, but you are logged in as <strong>{inv.signedInAs}</strong>.
            </p>
            <p>Log out and log back in with {inv.email} to accept it.</p>
          </div>
          <div className="onboarding-actions">
            <button type="button" className="button" onClick={switchAccount} disabled={busy}>
              {busy ? 'Logging out' : 'Switch account'}
            </button>
            <Link className="text-link" to="/app">Stay as {inv.signedInAs}</Link>
          </div>
        </>
      )
    }

    return (
      <>
        {diagram}
        {intro}
        {problem && <p className="auth-notice" role="alert">{problem}</p>}
        <div className="onboarding-actions">
          <button type="button" className="button" onClick={accept} disabled={busy}>
            {busy ? 'Joining' : `Join ${org}`}
          </button>
          <button type="button" className="auth-reset" onClick={() => decline(org)} disabled={busy}>
            Decline
          </button>
        </div>
        <p className="field-hint">The invitation expires {timeAgo(inv.expiresAt)}.</p>
      </>
    )
  }
}
