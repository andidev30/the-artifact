import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, fetchMe, logInWithPassword, passkeySignInOptions, setUpServer, signInWithPasskey, signUpWithPassword } from '../api'
import { askForPasskey, passkeyErrorText, passkeysSupported } from '../passkeys'
import { useConfig } from '../useConfig'
import { SSO_ERRORS, SsoButtons } from '../ee/SsoSignIn'
import { ServerUnreachable } from './Status'
import { Wordmark } from '../components/Wordmark'
import { APP_HOST, AUTH_EMAIL_URL, AUTH_GOOGLE_URL, LOGIN_URL, SIGNUP_URL } from '../config'
import { sameOriginPath } from '../next'
import './Auth.css'

type Mode = 'login' | 'signup'
type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string }

const COPY = {
  login: {
    title: 'Welcome back',
    lede: 'Log in to see the pages your agents have published.',
    submit: 'Email me a sign-in link',
    switchText: 'New here?',
    switchLink: 'Create an account',
    switchTo: SIGNUP_URL,
  },
  signup: {
    title: 'Create your account',
    lede: 'Free for personal use. No card needed.',
    submit: 'Email me a sign-up link',
    switchText: 'Already have an account?',
    switchLink: 'Log in',
    switchTo: LOGIN_URL,
  },
} as const

// Errors the API sends back to /login?error=…
const SIGN_IN_ERRORS: Record<string, string> = {
  google_not_configured: 'Google sign-in is not set up yet. Use your email instead.',
  google_cancelled: 'Google sign-in was cancelled. Try again, or use your email.',
  google_failed: 'Google sign-in did not work. Try again, or use your email.',
  google_unverified: 'Your Google account email is not verified. Use your email instead.',
  link_invalid: 'That sign-in link has already been used or is not valid. Request a new one below.',
  link_expired: 'That sign-in link has expired. Request a new one below.',
  account_suspended: 'This account is suspended. Ask an admin of this server if you think that is a mistake.',
  signup_closed: 'This server only accepts accounts from invited people and certain email domains. Ask an admin to invite you.',
  ...SSO_ERRORS,
}

export function Auth({ mode }: { mode: Mode }) {
  const [params] = useSearchParams()
  const plan = params.get('plan')
  // Where to go after signing in, e.g. back to an agent's connection request
  const next = sameOriginPath(params.get('next'), window.location.origin)
  const isOrg = mode === 'signup' && plan === 'organization'
  const copy = COPY[mode]
  const signInError = SIGN_IN_ERRORS[params.get('error') ?? '']
  const navigate = useNavigate()
  const config = useConfig()
  const settingUp = Boolean(config && !config.emailSignIn && config.needsSetup)

  // Someone already signed in has nothing to do here
  useEffect(() => {
    fetchMe()
      .then((me) => me && navigate(next ?? '/app', { replace: true }))
      .catch(() => {})
  }, [navigate, next])

  useEffect(() => {
    document.title = `${mode === 'login' ? 'Log in' : 'Sign up'} | The Artifact`
    return () => {
      document.title = 'The Artifact'
    }
  }, [mode])

  if (config?.unreachable) return <ServerUnreachable />

  const switchParams = new URLSearchParams({ ...(isOrg ? { plan: 'organization' } : {}), ...(next ? { next } : {}) }).toString()
  const switchQuery = switchParams ? `?${switchParams}` : ''

  const header = (
    <header className="nav">
      <Wordmark />
      {!settingUp && (
        <p className="auth-switch">
          <span className="auth-switch-text">{copy.switchText} </span>
          <Link to={copy.switchTo + switchQuery}>{copy.switchLink}</Link>
        </p>
      )}
    </header>
  )

  const form = settingUp ? (
    <SetupForm />
  ) : (
    <AuthForm
      mode={mode}
      plan={plan}
      next={next}
      notice={signInError}
      lede={
        isOrg
          ? 'You will set up your organization and invite your team after this step.'
          : config?.selfHosted && mode === 'signup'
            ? 'Create an account on this server.'
            : copy.lede
      }
    />
  )

  if (mode === 'login' || settingUp) {
    return (
      <div className="auth auth-login">
        {header}
        <main id="main" className="auth-main">
          {form}
        </main>
      </div>
    )
  }

  return (
    <div className="auth-signup">
      <div className="auth auth-signup-form">
        {header}
        <main id="main" className="auth-main">
          {form}
          {/* The hosted service's own terms; a self-hosted install has none of ours */}
          {config && !config.selfHosted && (
            <p className="auth-terms">
              By creating an account, you agree to the <Link to="/legal/terms">Terms of Service</Link> and the <Link to="/legal/privacy">Privacy Policy</Link>.
            </p>
          )}
        </main>
      </div>
      <SignupPanel />
    </div>
  )
}

function AuthForm({ mode, plan, next, lede, notice }: { mode: Mode; plan: string | null; next: string | null; lede: string; notice?: string }) {
  const copy = COPY[mode]
  const config = useConfig()
  // Self-hosted installs may run without Google sign-in configured
  const google = config?.googleSignIn ?? true
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const query = new URLSearchParams({ intent: mode, ...(plan ? { plan } : {}), ...(next ? { next } : {}) }).toString()
  // Servers without email: log in with a password; new people need a link from an admin
  const withPassword = config?.emailSignIn === false
  // Only when logging in: a passkey belongs to an account that already exists
  const passkey = mode === 'login' && passkeysSupported()
  // Enterprise single sign-on, first: where it is set up, it is how most people here sign in
  const sso = config?.sso?.length ? <SsoButtons connections={config.sso} query={query} /> : null

  async function onPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    setStatus({ kind: 'sending' })
    try {
      const { redirect } = await logInWithPassword(String(data.get('email') ?? '').trim(), String(data.get('password') ?? ''), plan, next)
      window.location.assign(redirect)
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof ApiError ? err.message : 'You could not be logged in. Check your connection and try again.' })
    }
  }

  async function onPasswordSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const password = String(data.get('password') ?? '')
    if (password !== String(data.get('confirm') ?? '')) return setStatus({ kind: 'error', message: 'The passwords don’t match.' })
    setStatus({ kind: 'sending' })
    try {
      const { redirect } = await signUpWithPassword(String(data.get('email') ?? '').trim(), password, String(data.get('name') ?? '').trim(), plan, next)
      window.location.assign(redirect)
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof ApiError ? err.message : 'Your account could not be created. Check your connection and try again.' })
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = String(new FormData(e.currentTarget).get('email') ?? '').trim()
    setStatus({ kind: 'sending' })
    try {
      const res = await fetch(AUTH_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, intent: mode, plan, next }),
      })
      // A refusal from the server (bad address, sign-ups closed, too many links) says why; show that
      if (res.status === 400 || res.status === 403 || res.status === 429) {
        const data = await res.json().catch(() => ({}))
        if (data.error) return setStatus({ kind: 'error', message: data.error })
      }
      if (!res.ok) throw new Error(String(res.status))
      setStatus({ kind: 'sent', email })
    } catch {
      setStatus({ kind: 'error', message: 'The link could not be sent. Check your connection and try again.' })
    }
  }

  if (status.kind === 'sent') {
    return (
      <section className="auth-box auth-sent" role="status" aria-labelledby="auth-title">
        <h1 id="auth-title">Check your inbox</h1>
        <p>
          We sent a link to <strong>{status.email}</strong>. Open it on this device to finish {mode === 'login' ? 'logging in' : 'creating your account'}.
        </p>
        <button type="button" className="auth-reset" onClick={() => setStatus({ kind: 'idle' })}>
          Use a different email
        </button>
      </section>
    )
  }

  // Until the config arrives, nothing: the form differs between servers with and without email
  if (!config) return <section className="auth-box" aria-busy="true" aria-label="Loading" />

  const googleButton = (
    <a className="button button-quiet auth-provider" href={`${AUTH_GOOGLE_URL}?${query}`}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#FFC107"
          d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
        />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
      Continue with Google
    </a>
  )

  if (withPassword && mode === 'signup' && config.passwordSignUp) {
    return (
      <section className="auth-box" aria-labelledby="auth-title">
        <h1 id="auth-title">{copy.title}</h1>
        <p className="auth-lede">{lede}</p>
        {notice && (
          <p className="auth-notice" role="alert">
            {notice}
          </p>
        )}
        {(google || sso) && (
          <>
            {sso}
            {google && googleButton}
            <div className="auth-divider">
              <span>or choose a password</span>
            </div>
          </>
        )}
        <form className="auth-form" onSubmit={onPasswordSignUp} noValidate>
          <label htmlFor="signup-name">Your name</label>
          <input id="signup-name" name="name" autoComplete="name" maxLength={80} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            aria-describedby="signup-password-hint"
          />
          <p id="signup-password-hint" className="field-hint">
            At least 8 characters.
          </p>
          <label htmlFor="signup-confirm">Confirm password</label>
          <input id="signup-confirm" name="confirm" type="password" autoComplete="new-password" required />
          {status.kind === 'error' && (
            <p id="auth-error" className="auth-error" role="alert">
              {status.message}
            </p>
          )}
          <button type="submit" className="button" disabled={status.kind === 'sending'}>
            {status.kind === 'sending' ? 'Creating your account' : 'Create account'}
          </button>
          <p className="field-hint">Invited to an organization? Open the invitation link you were sent instead.</p>
        </form>
      </section>
    )
  }

  if (withPassword && mode === 'signup') {
    return (
      <section className="auth-box" aria-labelledby="auth-title">
        <h1 id="auth-title">{copy.title}</h1>
        {notice && (
          <p className="auth-notice" role="alert">
            {notice}
          </p>
        )}
        {sso}
        {google && googleButton}
        <p className="auth-lede">
          {google || sso ? 'Or ask' : 'Ask'} an admin of this server for a sign-up link. This server doesn’t send email, so they pass it on to you themselves.
          If you were invited to an organization, open the invitation link instead.
        </p>
      </section>
    )
  }

  if (withPassword) {
    return (
      <section className="auth-box" aria-labelledby="auth-title">
        <h1 id="auth-title">{copy.title}</h1>
        <p className="auth-lede">{lede}</p>
        {notice && (
          <p className="auth-notice" role="alert">
            {notice}
          </p>
        )}
        {(google || passkey || sso) && (
          <>
            {sso}
            {google && googleButton}
            {passkey && <PasskeyButton plan={plan} next={next} />}
            <div className="auth-divider">
              <span>or use your password</span>
            </div>
          </>
        )}
        <form className="auth-form" onSubmit={onPasswordSubmit}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={status.kind === 'error' || undefined}
            aria-describedby={status.kind === 'error' ? 'auth-error' : 'password-hint'}
          />
          {status.kind === 'error' && (
            <p id="auth-error" className="auth-error" role="alert">
              {status.message}
            </p>
          )}
          <button type="submit" className="button" disabled={status.kind === 'sending'}>
            {status.kind === 'sending' ? 'Logging in' : 'Log in'}
          </button>
          <p id="password-hint" className="field-hint">
            Forgot your password? Ask an admin of this server for a reset link.
          </p>
        </form>
      </section>
    )
  }

  return (
    <section className="auth-box" aria-labelledby="auth-title">
      <h1 id="auth-title">{copy.title}</h1>
      <p className="auth-lede">{lede}</p>
      {notice && (
        <p className="auth-notice" role="alert">
          {notice}
        </p>
      )}

      {(google || passkey || sso) && (
        <>
          {sso}
          {google && googleButton}
          {passkey && <PasskeyButton plan={plan} next={next} />}
          <div className="auth-divider">
            <span>or use your email</span>
          </div>
        </>
      )}

      <form className="auth-form" onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          required
          aria-invalid={status.kind === 'error' || undefined}
          aria-describedby={status.kind === 'error' ? 'auth-error' : undefined}
        />
        {status.kind === 'error' && (
          <p id="auth-error" className="auth-error" role="alert">
            {status.message}
          </p>
        )}
        <button type="submit" className="button" disabled={status.kind === 'sending'}>
          {status.kind === 'sending' ? 'Sending link' : copy.submit}
        </button>
      </form>
    </section>
  )
}

// Signs in with a passkey alone: the browser offers the passkeys it has for this site, so no email is needed
function PasskeyButton({ plan, next }: { plan: string | null; next: string | null }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function onClick() {
    setBusy(true)
    setProblem(null)
    try {
      const response = await askForPasskey(await passkeySignInOptions())
      const { redirect } = await signInWithPasskey(response, plan, next)
      window.location.assign(redirect)
    } catch (err) {
      setProblem(passkeyErrorText(err, 'You could not be signed in with a passkey. Try again, or use another way.'))
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="button button-quiet auth-provider" onClick={onClick} disabled={busy}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="4" />
          <path d="M2 21v-1a6 6 0 0 1 9.5-4.9" />
          <circle cx="18" cy="14" r="2.5" />
          <path d="M18 16.5V22l1.5-1.5M18 19.5l1.5 1" />
        </svg>
        {busy ? 'Waiting for your passkey' : 'Sign in with a passkey'}
      </button>
      {problem && (
        <p className="auth-error" role="alert">
          {problem}
        </p>
      )}
    </>
  )
}

// First run on a server without email: the first account, which becomes the admin of this server
function SetupForm() {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ message: string; field?: string } | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const password = String(data.get('password') ?? '')
    if (password !== String(data.get('confirm') ?? '')) return setProblem({ message: 'The passwords don’t match.', field: 'confirm' })
    setBusy(true)
    setProblem(null)
    try {
      const { redirect } = await setUpServer(String(data.get('email') ?? '').trim(), password, String(data.get('name') ?? '').trim())
      window.location.assign(redirect)
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.code === 'already_set_up') return window.location.assign(LOGIN_URL)
      setProblem({
        message: err instanceof ApiError ? err.message : 'The account could not be created. Check your connection and try again.',
        field: err instanceof ApiError ? err.field : undefined,
      })
    }
  }

  const invalid = (field: string) => (problem?.field === field ? true : undefined)
  // The error is read out with the field it is about
  const describedBy = (field: string, hint?: string) => [hint, invalid(field) && 'setup-error'].filter(Boolean).join(' ') || undefined

  return (
    <section className="auth-box" aria-labelledby="auth-title">
      <h1 id="auth-title">Set up this server</h1>
      <p className="auth-lede">Create the first account. It becomes the admin of this server, so you can add people and choose who may sign up.</p>
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <label htmlFor="setup-name">Your name</label>
        <input id="setup-name" name="name" autoComplete="name" maxLength={80} />
        <label htmlFor="setup-email">Email</label>
        <input
          id="setup-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          required
          aria-invalid={invalid('email')}
          aria-describedby={describedBy('email')}
        />
        <label htmlFor="setup-password">Password</label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={invalid('password')}
          aria-describedby={describedBy('password', 'setup-password-hint')}
        />
        <p id="setup-password-hint" className="field-hint">
          At least 8 characters.
        </p>
        <label htmlFor="setup-confirm">Confirm password</label>
        <input
          id="setup-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={invalid('confirm')}
          aria-describedby={describedBy('confirm')}
        />
        {problem && (
          <p id="setup-error" className="auth-error" role="alert">
            {problem.message}
          </p>
        )}
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Creating your account' : 'Create admin account'}
        </button>
      </form>
    </section>
  )
}

// The blueprint side of sign-up: what the first minute with the product looks like
function SignupPanel() {
  return (
    <aside className="auth-panel" aria-label="What you can do after signing up">
      <div className="auth-panel-inner">
        <h2>Your first page is one prompt away.</h2>
        <div className="auth-panel-transcript">
          <p>
            <span className="auth-panel-caret" aria-hidden="true">
              &gt;
            </span>
            turn this CSV into a chart I can send to the team
          </p>
          <p className="auth-panel-tool">
            <span className="auth-panel-dot" aria-hidden="true" />
            publish_artifact
          </p>
          <p>
            Published. <mark>{APP_HOST}/a/signups-by-week</mark>
          </p>
        </div>
        <ul>
          <li>Works with Claude Code, Cursor, Codex and any MCP client</li>
          <li>Pages stay private until you share the link</li>
          <li>Ask for a change and the same link updates</li>
        </ul>
      </div>
    </aside>
  )
}
