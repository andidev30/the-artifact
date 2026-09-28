import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import {
  ApiError,
  getSecondFactorMethods,
  logout,
  secondFactorPasskeyOptions,
  sendSecondFactorCode,
  sendSecondFactorPasskey,
  type SecondFactorMethods,
} from '../api'
import { Wordmark } from '../components/Wordmark'
import { LOGIN_URL } from '../config'
import { askForPasskey, passkeyErrorText, passkeysSupported } from '../passkeys'
import './Auth.css'

type State = { kind: 'loading' } | { kind: 'expired' } | { kind: 'ready'; methods: SecondFactorMethods } | { kind: 'error' }

// The second step of signing in, after a password, an email link or Google, for accounts with a
// passkey or an authenticator app. The server keeps the first step in a short-lived cookie.
export function TwoFactor() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    document.title = 'Two-factor sign-in | The Artifact'
    getSecondFactorMethods()
      .then((methods) => setState({ kind: 'ready', methods }))
      .catch((err) => setState(err instanceof ApiError && err.status === 404 ? { kind: 'expired' } : { kind: 'error' }))
    return () => {
      document.title = 'The Artifact'
    }
  }, [])

  return (
    <div className="auth auth-login">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        {state.kind === 'loading' && <section className="auth-box" aria-busy="true" aria-label="Loading" />}
        {state.kind === 'expired' && (
          <section className="auth-box" aria-labelledby="two-factor-title">
            <h1 id="two-factor-title">Sign in again</h1>
            <p className="auth-lede">Your sign-in expired before it was finished. Sign in again to continue.</p>
            <Link className="button" to={LOGIN_URL}>
              Go to sign in
            </Link>
          </section>
        )}
        {state.kind === 'error' && (
          <section className="auth-box" aria-labelledby="two-factor-title">
            <h1 id="two-factor-title">Something went wrong</h1>
            <p className="auth-lede">Your sign-in could not be loaded. Check your connection and reload the page.</p>
          </section>
        )}
        {state.kind === 'ready' && <SecondFactor methods={state.methods} onExpired={() => setState({ kind: 'expired' })} />}
      </main>
    </div>
  )
}

function SecondFactor({ methods, onExpired }: { methods: SecondFactorMethods; onExpired: () => void }) {
  const passkey = methods.passkey && passkeysSupported()
  const [recovery, setRecovery] = useState(!methods.totp && !passkey && methods.recoveryCodes)
  const [busy, setBusy] = useState<'passkey' | 'code' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [code, setCode] = useState('')

  function failed(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.status === 401) return onExpired()
    setProblem(passkeyErrorText(err, fallback))
    setBusy(null)
  }

  async function usePasskey() {
    setBusy('passkey')
    setProblem(null)
    try {
      const response = await askForPasskey(await secondFactorPasskeyOptions())
      const { redirect } = await sendSecondFactorPasskey(response)
      window.location.assign(redirect)
    } catch (err) {
      failed(err, 'The passkey could not be checked. Try again.')
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy('code')
    setProblem(null)
    try {
      const { redirect } = await sendSecondFactorCode(code)
      window.location.assign(redirect)
    } catch (err) {
      failed(err, 'The code could not be checked. Check your connection and try again.')
      setCode('')
    }
  }

  const showCode = methods.totp || recovery

  return (
    <section className="auth-box" aria-labelledby="two-factor-title">
      <h1 id="two-factor-title">Confirm it’s you</h1>
      <p className="auth-lede">
        Signing in as <strong>{methods.email}</strong>.{' '}
        {passkey && methods.totp
          ? 'Use your passkey, or a code from your authenticator app.'
          : passkey
            ? 'Use your passkey to finish.'
            : 'Enter the code from your authenticator app.'}
      </p>

      {passkey && (
        <button type="button" className="button" onClick={usePasskey} disabled={busy !== null}>
          {busy === 'passkey' ? 'Waiting for your passkey' : 'Use your passkey'}
        </button>
      )}
      {methods.passkey && !passkeysSupported() && <p className="auth-notice">This browser can’t use passkeys. Use a code instead.</p>}

      {passkey && showCode && (
        <div className="auth-divider">
          <span>or enter a code</span>
        </div>
      )}

      {showCode && (
        <form className="auth-form" onSubmit={onSubmit}>
          <label htmlFor="two-factor-code">{recovery ? 'Recovery code' : '6-digit code'}</label>
          <input
            key={recovery ? 'recovery' : 'totp'}
            id="two-factor-code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete={recovery ? 'off' : 'one-time-code'}
            inputMode={recovery ? 'text' : 'numeric'}
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            spellCheck={false}
            autoCapitalize="none"
            required
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'two-factor-error' : undefined}
          />
          <button type="submit" className="button" disabled={busy !== null || !code.trim()}>
            {busy === 'code' ? 'Checking' : 'Continue'}
          </button>
        </form>
      )}

      {problem && (
        <p id="two-factor-error" className="auth-error" role="alert">
          {problem}
        </p>
      )}

      {methods.recoveryCodes && (methods.totp || passkey) && (
        <button
          type="button"
          className="auth-reset"
          onClick={() => {
            setRecovery(!recovery)
            setCode('')
            setProblem(null)
          }}
        >
          {recovery ? (methods.totp ? 'Use your authenticator app instead' : 'Use your passkey instead') : 'Use a recovery code'}
        </button>
      )}
      <p className="field-hint">
        Lost your passkeys and recovery codes? Ask an admin of this server to reset two-factor sign-in for you.{' '}
        <a className="text-link" href="/docs/signing-in#if-you-lose-your-second-factor">
          What to do
        </a>
      </p>
      <button
        type="button"
        className="auth-reset"
        onClick={async () => {
          await logout()
          window.location.assign(LOGIN_URL)
        }}
      >
        Sign in with another account
      </button>
    </section>
  )
}
