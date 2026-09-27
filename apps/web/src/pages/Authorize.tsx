import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { answerConsent, getConsentRequest, RequestExpired, type ConsentRequest } from '../api'
import { Wordmark } from '../components/Wordmark'
import './Auth.css'
import './Workspace.css'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; request: ConsentRequest }
  | { kind: 'done'; approved: boolean; clientName: string }
  | { kind: 'error'; message: string }

const LINK_ERRORS: Record<string, string> = {
  unknown_client: 'This connection link is not valid. Start the connection again from your agent.',
  bad_redirect: 'This connection link points somewhere The Artifact does not trust. Start the connection again from your agent.',
}

// Consent screen an MCP client sends people to while connecting
export function Authorize() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const requestId = params.get('request')
  const linkError = params.get('error')
  const [state, setState] = useState<State>(() =>
    linkError || !requestId ? { kind: 'error', message: LINK_ERRORS[linkError ?? ''] ?? LINK_ERRORS.unknown_client } : { kind: 'loading' },
  )
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!requestId || linkError) return
    getConsentRequest(requestId)
      .then((request) => {
        if (!request) {
          navigate(`/login?next=${encodeURIComponent(`/authorize?request=${requestId}`)}`, { replace: true })
          return
        }
        setWorkspace(request.workspaces[0]?.id ?? null)
        setState({ kind: 'ready', request })
      })
      .catch((err) =>
        setState({
          kind: 'error',
          message: err instanceof RequestExpired ? err.message : 'The connection request could not be loaded. Reload to try again.',
        }),
      )
  }, [requestId, linkError, navigate])

  async function answer(approve: boolean) {
    if (state.kind !== 'ready' || !requestId) return
    setBusy(true)
    try {
      const redirect = await answerConsent(requestId, approve, workspace)
      setState({ kind: 'done', approved: approve, clientName: state.request.clientName })
      window.location.href = redirect
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'The request could not be answered.' })
    }
  }

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box consent" aria-labelledby="consent-title" aria-busy={state.kind === 'loading'}>
          {state.kind === 'loading' && (
            <p className="auth-lede" role="status">
              Loading the connection request
            </p>
          )}

          {state.kind === 'error' && (
            <>
              <h1 id="consent-title">This connection can't continue</h1>
              <p className="auth-lede">{state.message}</p>
            </>
          )}

          {state.kind === 'done' && (
            <div role="status">
              <h1 id="consent-title">{state.approved ? `${state.clientName} is connected` : 'Connection declined'}</h1>
              <p className="auth-lede">
                {state.approved
                  ? `Go back to ${state.clientName} and ask it for a page. You can close this tab.`
                  : `${state.clientName} was not given access. You can close this tab.`}
              </p>
            </div>
          )}

          {state.kind === 'ready' && (
            <>
              <div className="consent-diagram" aria-hidden="true">
                <span className="consent-node">{state.request.clientName}</span>
                <span className="consent-wire" />
                <span className="consent-node consent-node-us">The Artifact</span>
              </div>
              <h1 id="consent-title">Connect {state.request.clientName}</h1>
              <p className="auth-lede">
                {state.request.clientName} will be able to publish pages, list them, read their HTML and change who can open them. It can't see your account
                settings or other workspaces.
              </p>

              {state.request.workspaces.length > 1 && (
                <fieldset className="consent-workspaces">
                  <legend>Publish pages to</legend>
                  {state.request.workspaces.map((w) => (
                    <label key={w.id ?? 'personal'} className="consent-option">
                      <input type="radio" name="workspace" checked={workspace === w.id} onChange={() => setWorkspace(w.id)} />
                      <span>{w.name}</span>
                    </label>
                  ))}
                </fieldset>
              )}

              <div className="onboarding-actions">
                <button type="button" className="button" onClick={() => answer(true)} disabled={busy}>
                  {busy ? 'Connecting' : `Allow ${state.request.clientName}`}
                </button>
                <button type="button" className="auth-reset" onClick={() => answer(false)} disabled={busy}>
                  Deny
                </button>
              </div>
              <p className="field-hint">You will be sent back to {state.request.redirectHost}.</p>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
