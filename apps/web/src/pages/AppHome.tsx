import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import type { Me } from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { ConnectTabs } from '../components/ConnectTabs'
import { Gallery } from '../components/Gallery'
import { InvitationNotice } from '../components/InvitationNotice'
import { APP_HOST } from '../config'
import { useMe } from '../useMe'
import { useWorkspace } from '../workspace'
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
  const { org } = useWorkspace(me)
  const workspace = org ? org.name : 'Personal'
  const [ownCount, setOwnCount] = useState(0)

  const published = me.hasPublished || ownCount > 0
  const steps = [true, me.agentConnected || published, published]
  const current = steps.indexOf(false)
  const stateOf = (i: number) => (steps[i] ? 'done' : i === current ? 'current' : 'todo')
  const allDone = current === -1

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={workspace} />
      <main id="main" className="app-main">
        <InvitationNotice me={me} />
        <div className="app-title">
          <h1>Pages</h1>
          <p>{org ? `Everything published to ${org.name}. Your role: ${ROLE_LABEL[org.role]}.` : 'Everything your agents publish for you.'}</p>
        </div>

        <Gallery
          key={org?.id ?? 'personal'}
          workspaceId={org?.id ?? 'personal'}
          workspaceName={workspace}
          email={me.email}
          onWorkspaceCount={setOwnCount}
          aside={
            allDone ? null : (
              <section className="auth-box getting-started" aria-labelledby="gs-title">
                <h2 id="gs-title">Get started</h2>
                <ol className="checklist">
                  <li data-state={stateOf(0)}>
                    <h3>{org ? `Create ${org.name}` : 'Set up your workspace'}</h3>
                    <p>Done. {org ? `Its address is ${APP_HOST}/${org.slug}.` : 'Pages you publish stay private until you share them.'}</p>
                  </li>
                  <li data-state={stateOf(1)}>
                    <h3>Connect your agent</h3>
                    {steps[1] ? (
                      <p>Done. Your agent can publish to {workspace}.</p>
                    ) : (
                      <>
                        <p>Add The Artifact once to the agent you use.</p>
                        <ConnectTabs />
                        <p className="field-hint">
                          Stuck?{' '}
                          <Link className="text-link" to="/docs/connect-your-agent">
                            Connect your agent
                          </Link>{' '}
                          covers every client.
                        </p>
                      </>
                    )}
                  </li>
                  <li data-state={stateOf(2)}>
                    <h3>Publish your first page</h3>
                    <p>Ask your agent for a page in plain words, for example:</p>
                    <div className="transcript">
                      <p>
                        <span className="caret" aria-hidden="true">
                          &gt;
                        </span>
                        turn this CSV into a chart I can send to the team
                      </p>
                    </div>
                  </li>
                </ol>
              </section>
            )
          }
        />
      </main>
    </div>
  )
}
