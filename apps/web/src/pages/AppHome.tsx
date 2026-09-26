import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { listArtifacts, type ArtifactSummary, type Me, type Visibility } from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { ConnectTabs } from '../components/ConnectTabs'
import { APP_HOST } from '../config'
import { timeAgo } from '../time'
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

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Restricted',
  organization: 'Organization',
  link: 'Anyone with the link',
}

type Gallery = { kind: 'loading' } | { kind: 'ready'; items: ArtifactSummary[] } | { kind: 'error' }

function Home({ me }: { me: Me }) {
  const org = me.organizations[0]
  const workspace = org ? org.name : 'Personal'
  const [tab, setTab] = useState<'workspace' | 'shared'>('workspace')
  const [gallery, setGallery] = useState<Gallery>({ kind: 'loading' })
  const [shared, setShared] = useState<ArtifactSummary[]>([])

  useEffect(() => {
    let active = true
    listArtifacts(org?.id ?? 'personal')
      .then((items) => active && setGallery({ kind: 'ready', items }))
      .catch(() => active && setGallery({ kind: 'error' }))
    listArtifacts('shared')
      .then((items) => active && setShared(items))
      .catch(() => {})
    return () => { active = false }
  }, [org?.id])

  const own = gallery.kind === 'ready' ? gallery.items : []
  const items = tab === 'workspace' ? own : shared
  const published = me.hasPublished || own.length > 0
  const steps = [true, me.agentConnected || published, published]
  const current = steps.indexOf(false)
  const stateOf = (i: number) => (steps[i] ? 'done' : i === current ? 'current' : 'todo')
  const allDone = current === -1

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

        <div className="gallery-tabs" role="tablist" aria-label="Which pages">
          <button type="button" role="tab" aria-selected={tab === 'workspace'} onClick={() => setTab('workspace')}>
            {workspace}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'shared'} onClick={() => setTab('shared')}>
            Shared with you{shared.length ? ` (${shared.length})` : ''}
          </button>
        </div>

        <div className={allDone || tab === 'shared' ? 'app-grid app-grid-full' : 'app-grid'}>
          {!allDone && tab === 'workspace' && (
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
                    </>
                  )}
                </li>
                <li data-state={stateOf(2)}>
                  <h3>Publish your first page</h3>
                  <p>Ask your agent for a page in plain words, for example:</p>
                  <div className="transcript">
                    <p><span className="caret" aria-hidden="true">&gt;</span>turn this CSV into a chart I can send to the team</p>
                  </div>
                </li>
              </ol>
            </section>
          )}

          {gallery.kind === 'error' && <p className="auth-notice" role="alert">Your pages could not be loaded. Reload to try again.</p>}

          {tab === 'shared' && shared.length === 0 && (
            <p className="gallery-note">Nothing has been shared with you yet. When someone adds {me.email} to a page, it shows up here.</p>
          )}

          {tab === 'workspace' && gallery.kind === 'ready' && items.length === 0 && (
            <section className="gallery-empty" aria-label="Your pages">
              <div className="ghost-grid" aria-hidden="true">
                <div className="ghost ghost-first"><span>Your first page lands here</span></div>
                <div className="ghost" />
                <div className="ghost" />
                <div className="ghost" />
              </div>
              <p>No pages yet. When your agent publishes, each page appears here with its link.</p>
            </section>
          )}

          {items.length > 0 && (
            <ul className="gallery" aria-label="Your pages">
              {items.map((a) => (
                <li key={a.slug}>
                  <Link className="page-card" to={`/a/${a.slug}`}>
                    <span className="page-card-thumb" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <strong>{a.title}</strong>
                    <span className="page-card-meta">
                      {a.role ? `Shared by ${a.owner}, updated ` : 'Updated '}{timeAgo(a.updatedAt)}
                      {a.mine || a.role ? '' : ` by ${a.owner}`}
                      {a.version > 1 ? `, version ${a.version}` : ''}
                    </span>
                    <span className="page-card-tags">
                      {a.role ? (
                        <span>{a.role === 'editor' ? 'Editor' : 'Viewer'}</span>
                      ) : (
                        <span data-visibility={a.visibility}>{VISIBILITY_LABEL[a.visibility]}</span>
                      )}
                      {a.publishedWith && <span>{a.publishedWith}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  )
}
