import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError, confirmSignInLink, getSignInLink, requestSignInLink, type SignInLink } from '../api'
import { Wordmark } from '../components/Wordmark'
import { LOGIN_URL } from '../config'
import { sameOriginPath } from '../next'
import './Auth.css'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; link: SignInLink }
  | { kind: 'expired'; email: string; newAccount: boolean; canResend: boolean }
  | { kind: 'invalid' }
  | { kind: 'closed'; message: string; suspended?: boolean }
  | { kind: 'error' }

type Resend = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; message: string }

// Where the emailed sign-in link lands. Opening it changes nothing, so a mail scanner that opens it first
// doesn't use it up; the person presses Continue to sign in.
export function ConfirmSignIn() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const plan = params.get('plan')
  const next = sameOriginPath(params.get('next'), window.location.origin)
  const [state, setState] = useState<State>(token ? { kind: 'loading' } : { kind: 'invalid' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ message: string; field?: string } | null>(null)
  const [resend, setResend] = useState<Resend>({ kind: 'idle' })

  useEffect(() => {
    document.title = 'Sign in | The Artifact'
    return () => {
      document.title = 'The Artifact'
    }
  }, [])

  useEffect(() => {
    if (!token) return
    let active = true
    getSignInLink(token)
      .then((link) => {
        if (!active) return
        setState(link.expired ? { kind: 'expired', email: link.email, newAccount: link.newAccount, canResend: link.emailEnabled } : { kind: 'ready', link })
      })
      .catch((err) => active && setState(err instanceof ApiError && err.status === 404 ? { kind: 'invalid' } : { kind: 'error' }))
    return () => {
      active = false
    }
  }, [token])

  async function onContinue(link: SignInLink, form?: HTMLFormElement) {
    let password: string | undefined
    let setupCode: string | undefined
    if (form) {
      const data = new FormData(form)
      if (link.setupCode) setupCode = String(data.get('setupCode') ?? '').trim()
      if (link.setPassword) {
        password = String(data.get('password') ?? '')
        if (password !== String(data.get('confirm') ?? '')) return setProblem({ message: 'The passwords don’t match.', field: 'confirm' })
      }
    }
    setBusy(true)
    setProblem(null)
    try {
      const { redirect } = await confirmSignInLink(token, plan, next, password, setupCode)
      window.location.assign(redirect)
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && (err.field === 'password' || err.field === 'setupCode')) return setProblem({ message: err.message, field: err.field })
      if (err instanceof ApiError && err.code === 'link_expired')
        return setState({ kind: 'expired', email: link.email, newAccount: link.newAccount, canResend: link.emailEnabled })
      if (err instanceof ApiError && err.code === 'link_invalid') return setState({ kind: 'invalid' })
      if (err instanceof ApiError && (err.code === 'signup_closed' || err.code === 'needs_setup')) return setState({ kind: 'closed', message: err.message })
      if (err instanceof ApiError && err.code === 'account_suspended') return setState({ kind: 'closed', message: err.message, suspended: true })
      setProblem({ message: 'You could not be signed in. Check your connection and try again.' })
    }
  }

  async function onResend(email: string, newAccount: boolean) {
    setResend({ kind: 'sending' })
    try {
      await requestSignInLink(email, newAccount ? 'signup' : 'login', plan, next)
      setResend({ kind: 'sent' })
    } catch (err) {
      setResend({ kind: 'failed', message: err instanceof ApiError ? err.message : 'The link could not be sent. Try again.' })
    }
  }

  const invalid = (field: string) => (problem?.field === field ? true : undefined)
  // The error is read out with the field it is about
  const describedBy = (field: string, hint?: string) => [hint, invalid(field) && 'confirm-error'].filter(Boolean).join(' ') || undefined

  const loginAgain = `${LOGIN_URL}${next ? `?next=${encodeURIComponent(next)}` : ''}`

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box confirm" aria-labelledby="confirm-title" aria-busy={state.kind === 'loading'}>
          {state.kind === 'loading' && (
            <p className="auth-lede" role="status">
              Checking your sign-in link
            </p>
          )}

          {state.kind === 'ready' && (
            <>
              <h1 id="confirm-title">{state.link.newAccount ? 'Create your account' : 'Log in to The Artifact'}</h1>
              <p className="auth-lede">
                {state.link.newAccount ? 'You are about to create an account as' : 'You are about to log in as'}{' '}
                <strong className="confirm-email">{state.link.email}</strong>.
              </p>
              {state.link.setPassword || state.link.setupCode ? (
                <form
                  className="auth-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void onContinue(state.link, e.currentTarget)
                  }}
                  noValidate
                >
                  {state.link.setupCode && (
                    <>
                      <label htmlFor="confirm-setup-code">Setup code</label>
                      <input
                        id="confirm-setup-code"
                        name="setupCode"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        required
                        aria-invalid={invalid('setupCode')}
                        aria-describedby={describedBy('setupCode', 'confirm-setup-code-hint')}
                      />
                      <p id="confirm-setup-code-hint" className="field-hint">
                        This is the first account on this server, so it becomes its admin. The server prints the code to its log when it starts, e.g.{' '}
                        <code>docker compose logs app</code>.
                      </p>
                    </>
                  )}
                  {state.link.setPassword && (
                    <>
                      <input type="email" name="username" autoComplete="username" value={state.link.email} readOnly hidden />
                      <label htmlFor="confirm-password">{state.link.newAccount ? 'Choose a password' : 'New password'}</label>
                      <input
                        id="confirm-password"
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        required
                        aria-invalid={invalid('password')}
                        aria-describedby={describedBy('password', 'confirm-password-hint')}
                      />
                      <p id="confirm-password-hint" className="field-hint">
                        At least 8 characters. You will log in with it from now on.
                      </p>
                      <label htmlFor="confirm-password-again">Confirm password</label>
                      <input
                        id="confirm-password-again"
                        name="confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        aria-invalid={invalid('confirm')}
                        aria-describedby={describedBy('confirm')}
                      />
                    </>
                  )}
                  {problem && (
                    <p id="confirm-error" className="auth-error" role="alert">
                      {problem.message}
                    </p>
                  )}
                  <button type="submit" className="button confirm-continue" disabled={busy}>
                    {busy
                      ? 'Signing in'
                      : !state.link.setPassword
                        ? `Continue as ${state.link.email}`
                        : state.link.newAccount
                          ? 'Create my account'
                          : 'Set password and log in'}
                  </button>
                </form>
              ) : (
                <>
                  {problem && (
                    <p className="auth-notice" role="alert">
                      {problem.message}
                    </p>
                  )}
                  <button type="button" className="button confirm-continue" onClick={() => onContinue(state.link)} disabled={busy}>
                    {busy ? 'Signing in' : `Continue as ${state.link.email}`}
                  </button>
                  <p className="field-hint">Didn't ask for this? Close this tab and nothing happens.</p>
                </>
              )}
            </>
          )}

          {state.kind === 'expired' && (
            <>
              <h1 id="confirm-title">This sign-in link has expired</h1>
              {!state.canResend ? (
                <p className="auth-lede">
                  Ask an admin of this server for a new link for <strong className="confirm-email">{state.email}</strong>.
                </p>
              ) : (
                <>
                  <p className="auth-lede">
                    Links work for 15 minutes. Get a new one for <strong className="confirm-email">{state.email}</strong>.
                  </p>
                  {resend.kind === 'sent' ? (
                    <p className="confirm-sent" role="status">
                      We sent a new link. Check your inbox.
                    </p>
                  ) : (
                    <>
                      {resend.kind === 'failed' && (
                        <p className="auth-notice" role="alert">
                          {resend.message}
                        </p>
                      )}
                      <button
                        type="button"
                        className="button confirm-continue"
                        onClick={() => onResend(state.email, state.newAccount)}
                        disabled={resend.kind === 'sending'}
                      >
                        {resend.kind === 'sending' ? 'Sending link' : 'Email me a new link'}
                      </button>
                    </>
                  )}
                  <Link className="auth-reset" to={loginAgain}>
                    Use a different email
                  </Link>
                </>
              )}
            </>
          )}

          {state.kind === 'invalid' && (
            <>
              <h1 id="confirm-title">This sign-in link can't be used</h1>
              <p className="auth-lede">
                It has already been used or is not valid. Each link works once. If you already pressed Continue in another tab, you are signed in there.
              </p>
              <Link className="button" to={loginAgain}>
                Request a new link
              </Link>
            </>
          )}

          {state.kind === 'closed' && (
            <>
              <h1 id="confirm-title">{state.suspended ? 'This account is suspended' : 'Sign-ups are closed'}</h1>
              <p className="auth-lede">{state.message}</p>
            </>
          )}

          {state.kind === 'error' && (
            <>
              <h1 id="confirm-title">The link could not be checked</h1>
              <p className="auth-lede">The server did not respond. Reload the page to try again.</p>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
