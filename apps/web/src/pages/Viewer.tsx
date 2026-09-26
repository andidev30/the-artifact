import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { fetchMe, getArtifact, logout, type ArtifactPage, type Visibility } from '../api'
import { HistoryPanel, OldVersionBar, type Viewing } from '../components/HistoryPanel'
import { DeleteDialog, PageMenu, RenameDialog, type MenuItem } from '../components/PageActions'
import { ShareDialog } from '../components/ShareDialog'
import { Wordmark } from '../components/Wordmark'
import { LOGIN_URL } from '../config'
import { timeAgo } from '../time'
import './Auth.css'
import './Viewer.css'

type State = { kind: 'loading' } | { kind: 'ready'; page: ArtifactPage; email: string | null } | { kind: 'missing'; email: string | null } | { kind: 'error' }

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Restricted',
  organization: 'Organization',
  link: 'Anyone with the link',
}

// Opaque origin: the page's scripts run, but can't read cookies or reach this app
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

export function Viewer() {
  const { slug = '' } = useParams()
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    getArtifact(slug)
      .then(async (page) => {
        if (!active) return
        if (page) {
          const me = page.canEdit ? await fetchMe().catch(() => null) : null
          if (!active) return
          setState({ kind: 'ready', page, email: me?.email ?? null })
          document.title = `${page.title} | The Artifact`
        } else {
          const me = await fetchMe().catch(() => null)
          if (active) setState({ kind: 'missing', email: me?.email ?? null })
        }
      })
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
      document.title = 'The Artifact'
    }
  }, [slug])

  if (state.kind === 'loading') return <div className="viewer-status" role="status">Loading page</div>
  if (state.kind === 'error') return <div className="viewer-status" role="alert">The page could not be loaded. Reload to try again.</div>
  if (state.kind === 'missing') return <Unavailable slug={slug} email={state.email} />

  return <PageFrame page={state.page} email={state.email} onChange={(page) => setState({ ...state, page })} />
}

// Missing and no-access look the same on purpose, so private pages don't reveal they exist
function Unavailable({ slug, email }: { slug: string; email: string | null }) {
  const back = `${LOGIN_URL}?next=${encodeURIComponent(`/a/${slug}`)}`

  async function switchAccount() {
    await logout()
    window.location.href = back
  }

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box unavailable" aria-labelledby="unavailable-title">
          <span className="unavailable-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20"><path d="M6 9V7a4 4 0 1 1 8 0v2M5 9h10v8H5z" /></svg>
          </span>
          <h1 id="unavailable-title">This page isn't available</h1>
          {email ? (
            <>
              <p className="auth-lede">
                You're signed in as <strong>{email}</strong>, and this page isn't shared with that address. It may
                also have been deleted.
              </p>
              <p className="auth-lede">Ask the person who sent it to share it with {email}, or switch to the account it was shared with.</p>
              <div className="unavailable-actions">
                <button type="button" className="button" onClick={switchAccount}>Switch account</button>
                <Link className="text-link" to="/app">Go to your pages</Link>
              </div>
            </>
          ) : (
            <>
              <p className="auth-lede">It's private or it was deleted. If it was shared with you, log in with the email address it was sent to.</p>
              <div className="unavailable-actions">
                <Link className="button" to={back}>Log in to open it</Link>
                <Link className="text-link" to="/">What is The Artifact?</Link>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function PageFrame({ page, email, onChange }: { page: ArtifactPage; email: string | null; onChange: (p: ArtifactPage) => void }) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [announce, setAnnounce] = useState('')

  const menu: MenuItem[] = []
  if (page.canEdit) menu.push({ label: 'Rename', onSelect: () => setDialog('rename') })
  if (page.isOwner) menu.push({ label: 'Delete', onSelect: () => setDialog('delete'), danger: true })

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  async function onRestored(from: number) {
    const fresh = await getArtifact(page.slug).catch(() => null)
    if (fresh) onChange(fresh)
    setViewing(null)
    setAnnounce(`Version ${from} was restored as version ${fresh?.version ?? page.version + 1}.`)
  }

  return (
    <div className="artifact-view">
      <header className="viewer-bar">
        <Link className="viewer-mark" to="/app" aria-label="The Artifact">
          <span className="wordmark-mark" aria-hidden="true" />
        </Link>
        <div className="viewer-title">
          <h1>{page.title}</h1>
          <p>
            Version {page.version}, updated {timeAgo(page.updatedAt)}
            {page.owner ? ` by ${page.owner}` : ''}
          </p>
        </div>
        <div className="viewer-actions">
          <span className="viewer-badge" data-visibility={page.visibility}>{VISIBILITY_LABEL[page.visibility]}</span>
          {page.canEdit && (
            <button type="button" className="viewer-history" aria-expanded={historyOpen} aria-controls="history-panel" onClick={() => setHistoryOpen((o) => !o)}>
              History
            </button>
          )}
          {page.canEdit ? (
            <button type="button" className="viewer-copy" onClick={() => setSharing(true)}>Share</button>
          ) : (
            <button type="button" className="viewer-copy" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
          )}
          <PageMenu label="More actions" items={menu} />
        </div>
        <span className="visually-hidden" role="status">{copied ? 'Link copied' : announce}</span>
      </header>
      {viewing && (
        <OldVersionBar
          key={viewing.version}
          slug={page.slug}
          viewing={viewing}
          onBack={() => setViewing(null)}
          onRestored={() => onRestored(viewing.version)}
        />
      )}
      <div className="viewer-body">
        <iframe
          key={viewing ? `v${viewing.version}` : 'current'}
          className="viewer-frame"
          title={viewing ? `${page.title}, version ${viewing.version}` : page.title}
          sandbox={SANDBOX}
          srcDoc={viewing ? viewing.html : page.html}
        />
        {historyOpen && (
          <HistoryPanel
            slug={page.slug}
            currentVersion={page.version}
            selected={viewing?.version ?? page.version}
            onSelect={setViewing}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
      {dialog === 'rename' && (
        <RenameDialog
          slug={page.slug}
          title={page.title}
          onClose={() => setDialog(null)}
          onRenamed={(title) => {
            onChange({ ...page, title, updatedAt: new Date().toISOString() })
            document.title = `${title} | The Artifact`
            setAnnounce(`Renamed to “${title}”.`)
          }}
        />
      )}
      {dialog === 'delete' && (
        <DeleteDialog slug={page.slug} title={page.title} onClose={() => setDialog(null)} onDeleted={() => navigate('/app', { replace: true })} />
      )}
      {sharing && (
        <ShareDialog
          slug={page.slug}
          title={page.title}
          currentUserEmail={email}
          onClose={() => setSharing(false)}
          onVisibilityChange={(visibility: Visibility) => onChange({ ...page, visibility })}
        />
      )}
    </div>
  )
}
