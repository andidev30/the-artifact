import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { Me } from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { ConnectTabs } from '../components/ConnectTabs'
import { APP_HOST } from '../config'
import { useMe } from '../useMe'
import { LoadError, Loading } from './Status'
import './Workspace.css'

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const

export function AppHome() {
  const state = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  // First visit after signing up: set up the workspace before anything else
  useEffect(() => {
    if (state.kind === 'ready' && !state.me.onboarded) {
      const plan = params.get('plan')
      navigate(`/onboarding${plan ? `?plan=${encodeURIComponent(plan)}` : ''}`, { replace: true })
    }
  }, [state, navigate, params])

  if (state.kind === 'loading') return <Loading />
  if (state.kind === 'error') return <LoadError />
  if (!state.me.onboarded) return null
  return <Home me={state.me} />
}

function Home({ me }: { me: Me }) {
  const org = me.organizations[0]
  const workspace = org ? org.name : 'Personal'

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={workspace} />
      <main id="main" className="app-main">
        <div className="app-title">
          <h1>Pages</h1>
          <p>
            {org
              ? `Everything published to ${org.name}. Your role: ${ROLE_LABEL[org.role]}.`
              : 'Everything your agents publish for you.'}
          </p>
        </div>

        <div className="app-grid">
          <section className="auth-box getting-started" aria-labelledby="gs-title">
            <h2 id="gs-title">Get started</h2>
            <ol className="checklist">
              <li data-state="done">
                <h3>{org ? `Create ${org.name}` : 'Set up your workspace'}</h3>
                <p>Done. {org ? `Its address is ${APP_HOST}/${org.slug}.` : 'Pages you publish stay private until you share them.'}</p>
              </li>
              <li data-state="current">
                <h3>Connect your agent</h3>
                <p>Add The Artifact once to the agent you use.</p>
                <ConnectTabs />
              </li>
              <li data-state="todo">
                <h3>Publish your first page</h3>
                <p>Ask your agent for a page in plain words, for example:</p>
                <div className="transcript">
                  <p><span className="caret" aria-hidden="true">&gt;</span>turn this CSV into a chart I can send to the team</p>
                </div>
              </li>
            </ol>
          </section>

          <section className="gallery-empty" aria-label="Your pages">
            <div className="ghost-grid" aria-hidden="true">
              <div className="ghost ghost-first"><span>Your first page lands here</span></div>
              <div className="ghost" />
              <div className="ghost" />
              <div className="ghost" />
            </div>
            <p>No pages yet. When your agent publishes, each page appears here with its link.</p>
          </section>
        </div>
      </main>
    </div>
  )
}
