import { useEffect, useState, type FormEvent } from 'react'
import {
  addPasskey,
  ApiError,
  confirmTotp,
  endSession,
  getSignInSecurity,
  listSessions,
  logout,
  newRecoveryCodes,
  passkeyRegistrationOptions,
  removePasskey,
  removeTotp,
  renamePasskey,
  signOutOtherSessions,
  startTotpSetup,
  type Passkey,
  type SignedInSession,
  type SignInSecurity,
  type TotpSetup,
} from '../api'
import { LOGIN_URL } from '../config'
import { createPasskey, passkeyErrorText, passkeysSupported } from '../passkeys'
import { timeAgo } from '../time'
import { refreshMe } from '../useMe'
import { CopyCommand } from './CopyCommand'
import './SignInSecurity.css'

type Loadable<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error' }

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const listOf = (names: string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

// Signing out and back in, for changes that need a recent sign-in
async function signInAgain() {
  await logout()
  window.location.assign(`${LOGIN_URL}?next=${encodeURIComponent('/settings#security')}`)
}

// Passkeys, the authenticator app and recovery codes, in account settings
export function SecuritySection({ required }: { required: boolean }) {
  const [state, setState] = useState<Loadable<SignInSecurity>>({ kind: 'loading' })
  const [codes, setCodes] = useState<string[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function reload() {
    try {
      setState({ kind: 'ready', data: await getSignInSecurity() })
    } catch {
      setState({ kind: 'error' })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once
  useEffect(() => {
    reload()
  }, [])

  // After any change: new recovery codes (shown once), and the account's own state
  function changed(recoveryCodes?: string[]) {
    if (recoveryCodes) setCodes(recoveryCodes)
    setProblem(null)
    reload()
    refreshMe()
  }

  function failed(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.code === 'reauth_required') reload()
    setProblem(passkeyErrorText(err, errorText(err, fallback)))
  }

  const data = state.kind === 'ready' ? state.data : null
  const hasFactor = Boolean(data && (data.passkeys.length > 0 || data.totp))
  const locked = data ? !data.recentSignIn : false

  return (
    <section id="security" className="settings-card" aria-labelledby="security-title">
      <header className="settings-card-head">
        <h2 id="security-title">Sign-in security</h2>
        <p>
          Add a passkey or an authenticator app, and signing in asks for it after your password, email link or Google. A passkey can also sign you in on its
          own.
        </p>
      </header>

      {state.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading
        </p>
      )}
      {state.kind === 'error' && (
        <p className="auth-notice" role="alert">
          Your sign-in security could not be loaded. Reload to try again.
        </p>
      )}

      {data && !hasFactor && (data.requiredBy.length > 0 || required) && (
        <p className="security-required" role="status">
          {data.requiredBy.length > 0
            ? `${listOf(data.requiredBy.map((o) => o.name))} ${data.requiredBy.length === 1 ? 'requires' : 'require'} two-factor sign-in. Add a passkey or an authenticator app to use ${data.requiredBy.length === 1 ? 'it' : 'them'}.`
            : 'Add a passkey or an authenticator app to finish setting up two-factor sign-in.'}
        </p>
      )}

      {locked && (
        <div className="security-locked">
          <p>For your security, sign in again before you change how you sign in. It needs a sign-in from the last hour.</p>
          <button type="button" className="button button-small" onClick={signInAgain}>
            Sign in again
          </button>
        </div>
      )}

      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}

      {data && (
        <>
          <Passkeys passkeys={data.passkeys} locked={locked} onChanged={changed} onFailed={failed} />
          <AuthenticatorApp enabled={data.totp} locked={locked} onChanged={changed} onFailed={failed} />
          {hasFactor && (
            <div className="security-block">
              <h3 className="settings-subhead">Recovery codes</h3>
              <p className="settings-muted">
                {data.recoveryCodes === 0
                  ? 'You have no recovery codes left. Make new ones, so you can still sign in if you lose your passkeys and phone.'
                  : `${data.recoveryCodes} of 10 left. Each one signs you in once, in place of your passkey or authenticator app.`}
              </p>
              <RegenerateCodes locked={locked} onChanged={changed} onFailed={failed} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Passkeys({
  passkeys,
  locked,
  onChanged,
  onFailed,
}: {
  passkeys: Passkey[]
  locked: boolean
  onChanged: (codes?: string[]) => void
  onFailed: (err: unknown, fallback: string) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const supported = passkeysSupported()

  async function add(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const response = await createPasskey(await passkeyRegistrationOptions())
      const { recoveryCodes } = await addPasskey(name.trim() || 'Passkey', response)
      setName('')
      onChanged(recoveryCodes)
    } catch (err) {
      onFailed(err, 'The passkey could not be added. Try again.')
    }
    setBusy(false)
  }

  async function remove(p: Passkey) {
    try {
      await removePasskey(p.id)
      onChanged()
    } catch (err) {
      onFailed(err, `${p.name} could not be removed. Try again.`)
    }
    setConfirming(null)
  }

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (!renaming) return
    try {
      await renamePasskey(renaming.id, renaming.name)
      setRenaming(null)
      onChanged()
    } catch (err) {
      onFailed(err, 'The passkey could not be renamed. Try again.')
    }
  }

  return (
    <div className="security-block">
      <h3 className="settings-subhead">Passkeys</h3>
      {passkeys.length > 0 && (
        <ul className="settings-list" aria-label="Passkeys">
          {passkeys.map((p) => (
            <li key={p.id} className="settings-row">
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              {renaming?.id === p.id ? (
                <form className="settings-inline security-rename" onSubmit={rename}>
                  <label className="visually-hidden" htmlFor={`passkey-name-${p.id}`}>
                    Name
                  </label>
                  <input
                    id={`passkey-name-${p.id}`}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    maxLength={60}
                    required
                    autoFocus
                  />
                  <button type="submit" className="button button-small" disabled={!renaming.name.trim()}>
                    Save
                  </button>
                  <button type="button" className="auth-reset" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <span className="settings-who">
                  <strong>{p.name}</strong>
                  <span>
                    {p.backedUp ? 'Synced passkey' : 'On one device'}, added {timeAgo(p.createdAt)}
                  </span>
                </span>
              )}
              {renaming?.id !== p.id && (
                <>
                  <span className="settings-meta">{p.lastUsedAt ? `Last used ${timeAgo(p.lastUsedAt)}` : 'Not used yet'}</span>
                  <span className="settings-actions">
                    {confirming === p.id ? (
                      <>
                        <button type="button" className="button button-small button-danger" onClick={() => remove(p)}>
                          Remove
                        </button>
                        <button type="button" className="auth-reset" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="auth-reset" aria-label={`Rename ${p.name}`} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                          Rename
                        </button>
                        <button
                          type="button"
                          className="button button-small button-quiet"
                          aria-label={`Remove ${p.name}`}
                          disabled={locked}
                          onClick={() => setConfirming(p.id)}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <form className="settings-inline security-add" onSubmit={add}>
          <label className="visually-hidden" htmlFor="passkey-name">
            Passkey name
          </label>
          <input
            id="passkey-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name it, like MacBook or YubiKey"
            maxLength={60}
            autoComplete="off"
          />
          <button type="submit" className="button button-small" disabled={busy || locked}>
            {busy ? 'Waiting for your passkey' : 'Add a passkey'}
          </button>
        </form>
      ) : (
        <p className="settings-muted">This browser can’t make passkeys. Try another browser, or use an authenticator app.</p>
      )}
    </div>
  )
}

function AuthenticatorApp({
  enabled,
  locked,
  onChanged,
  onFailed,
}: {
  enabled: boolean
  locked: boolean
  onChanged: (codes?: string[]) => void
  onFailed: (err: unknown, fallback: string) => void
}) {
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function start() {
    setBusy(true)
    try {
      setSetup(await startTotpSetup())
    } catch (err) {
      onFailed(err, 'The authenticator app could not be set up. Try again.')
    }
    setBusy(false)
  }

  async function confirm(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { recoveryCodes } = await confirmTotp(code)
      setSetup(null)
      setCode('')
      onChanged(recoveryCodes)
    } catch (err) {
      onFailed(err, 'The code could not be checked. Try again.')
      setCode('')
    }
    setBusy(false)
  }

  async function remove() {
    try {
      await removeTotp()
      onChanged()
    } catch (err) {
      onFailed(err, 'The authenticator app could not be removed. Try again.')
    }
    setConfirming(false)
  }

  return (
    <div className="security-block">
      <h3 className="settings-subhead">Authenticator app</h3>
      {enabled ? (
        <div className="security-app">
          <p className="settings-muted">On. Signing in asks for a 6-digit code from the app when you don’t use a passkey.</p>
          {confirming ? (
            <span className="settings-actions">
              <button type="button" className="button button-small button-danger" onClick={remove}>
                Remove
              </button>
              <button type="button" className="auth-reset" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="button button-small button-quiet" disabled={locked} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      ) : setup ? (
        <div className="security-totp">
          <ol className="security-steps">
            <li>
              Scan this code with an authenticator app, like 1Password, Google Authenticator or Microsoft Authenticator.
              <img className="security-qr" src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} />
            </li>
            <li>
              Can’t scan it? Enter this key in the app instead.
              <CopyCommand command={setup.secret} label="Copy the key" plain />
            </li>
            <li>
              <form className="settings-inline" onSubmit={confirm}>
                <label htmlFor="totp-code">Enter the 6-digit code the app shows</label>
                <input
                  id="totp-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  maxLength={8}
                  required
                />
                <button type="submit" className="button button-small" disabled={busy || !code.trim()}>
                  {busy ? 'Checking' : 'Turn on'}
                </button>
                <button type="button" className="auth-reset" onClick={() => setSetup(null)}>
                  Cancel
                </button>
              </form>
            </li>
          </ol>
        </div>
      ) : (
        <div className="security-app">
          <p className="settings-muted">Codes from an app on your phone, for when you can’t use a passkey.</p>
          <button type="button" className="button button-small button-quiet" onClick={start} disabled={busy || locked}>
            Set up
          </button>
        </div>
      )}
    </div>
  )
}

function RegenerateCodes({
  locked,
  onChanged,
  onFailed,
}: {
  locked: boolean
  onChanged: (codes?: string[]) => void
  onFailed: (err: unknown, fallback: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  async function run() {
    try {
      onChanged((await newRecoveryCodes()).recoveryCodes)
    } catch (err) {
      onFailed(err, 'New recovery codes could not be made. Try again.')
    }
    setConfirming(false)
  }

  return confirming ? (
    <div className="security-app">
      <p className="settings-muted">Your old codes stop working.</p>
      <span className="settings-actions">
        <button type="button" className="button button-small" onClick={run}>
          Make new codes
        </button>
        <button type="button" className="auth-reset" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    </div>
  ) : (
    <div>
      <button type="button" className="button button-small button-quiet" disabled={locked} onClick={() => setConfirming(true)}>
        Make new codes
      </button>
    </div>
  )
}

// Shown once, right after they are made
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n')
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`Recovery codes for ${window.location.host}\n\n${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="settings-token-new security-codes" role="status">
      <p>
        <strong>Save your recovery codes now.</strong> You won’t see them again. Each one signs you in once if you lose your passkeys and phone. Keep them
        somewhere safe, like a password manager.
      </p>
      <ul className="security-code-list" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="security-code-actions">
        <button type="button" className="button button-small button-quiet" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="button button-small button-quiet" onClick={download}>
          Download
        </button>
        <button type="button" className="button button-small" onClick={onDone}>
          I saved them
        </button>
      </div>
    </div>
  )
}

const deviceName = (s: SignedInSession) => (s.browser && s.os ? `${s.browser} on ${s.os}` : (s.browser ?? s.os ?? 'Unknown device'))

// Where you are signed in, with a way to sign each one out
export function SessionsSection() {
  const [sessions, setSessions] = useState<Loadable<SignedInSession[]>>({ kind: 'loading' })
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function reload() {
    try {
      setSessions({ kind: 'ready', data: await listSessions() })
    } catch {
      setSessions({ kind: 'error' })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once
  useEffect(() => {
    reload()
  }, [])

  async function end(s: SignedInSession) {
    setProblem(null)
    try {
      await endSession(s.id)
      if (s.current) return window.location.assign(LOGIN_URL)
      setDone(`${deviceName(s)} was signed out.`)
      reload()
    } catch (err) {
      setProblem(errorText(err, 'That session could not be signed out. Try again.'))
    }
  }

  async function others() {
    setProblem(null)
    try {
      await signOutOtherSessions()
      setDone('Every other device was signed out.')
      reload()
    } catch (err) {
      setProblem(errorText(err, 'The other devices could not be signed out. Try again.'))
    }
  }

  const list = sessions.kind === 'ready' ? sessions.data : []

  return (
    <section id="sessions" className="settings-card" aria-labelledby="sessions-title">
      <header className="settings-card-head">
        <h2 id="sessions-title">Sessions</h2>
        <p>Browsers where you are signed in. Sign out any you don’t recognize, then change your password or sign-in security.</p>
      </header>
      {sessions.kind === 'error' && (
        <p className="auth-notice" role="alert">
          Your sessions could not be loaded. Reload to try again.
        </p>
      )}
      {problem && (
        <p className="auth-notice" role="alert">
          {problem}
        </p>
      )}
      {list.length > 0 && (
        <ul className="settings-list" aria-label="Sessions">
          {list.map((s) => (
            <li key={s.id} className="settings-row">
              <span className="settings-avatar settings-avatar-agent" aria-hidden="true">
                {(s.browser ?? '?').slice(0, 1)}
              </span>
              <span className="settings-who">
                <strong>
                  {deviceName(s)}
                  {s.current && <span className="settings-you">This device</span>}
                </strong>
                <span>Signed in {timeAgo(s.createdAt)}</span>
              </span>
              <span className="settings-meta">{s.current ? 'Active now' : `Active ${timeAgo(s.lastActiveAt)}`}</span>
              <span className="settings-actions">
                <button type="button" className="button button-small button-quiet" aria-label={`Sign out ${deviceName(s)}`} onClick={() => end(s)}>
                  Sign out
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.length > 1 && (
        <div className="settings-signout">
          <button type="button" className="button button-small button-quiet" onClick={others}>
            Sign out other devices
          </button>
        </div>
      )}
      <p className="field-hint" aria-live="polite">
        {done ?? ''}
      </p>
    </section>
  )
}
