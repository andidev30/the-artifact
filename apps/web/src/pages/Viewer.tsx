import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { downloadUrl, FRAME_SANDBOX, fetchMe, getArtifact, logout, PasswordNeeded, unlockPage, versionUrl, type ArtifactPage, type Visibility } from '../api'
import { CommentsPanel } from '../components/CommentsPanel'
import { HistoryPanel, OldVersionBar, type Viewing } from '../components/HistoryPanel'
import { DeleteDialog, PageMenu, RenameDialog, type MenuItem } from '../components/PageActions'
import { ShareDialog } from '../components/ShareDialog'
import { ViewsPanel } from '../components/ViewsPanel'
import { Wordmark } from '../components/Wordmark'
import { LOGIN_URL } from '../config'
import { timeAgo } from '../time'
import './Auth.css'
import './Viewer.css'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; page: ArtifactPage; email: string | null }
  | { kind: 'missing'; email: string | null }
  | { kind: 'locked' }
  | { kind: 'error' }

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Restricted',
  organization: 'Organization',
  link: 'Anyone with the link',
}

export function Viewer() {
  const { slug = '' } = useParams()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // The key of a public link (/a/<slug>?k=<key>), for people without access of their own
  const key = useSearchParams()[0].get('k')

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt loads the page again once the password is entered
  useEffect(() => {
    let active = true
    getArtifact(slug, key)
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
      .catch((err) => active && setState(err instanceof PasswordNeeded ? { kind: 'locked' } : { kind: 'error' }))
    return () => {
      active = false
    }
  }, [slug, key, attempt])

  useEffect(
    () => () => {
      document.title = 'The Artifact'
    },
    [],
  )

  if (state.kind === 'loading')
    return (
      <div className="viewer-status" role="status">
        Loading page
      </div>
    )
  if (state.kind === 'error')
    return (
      <div className="viewer-status" role="alert">
        The page could not be loaded. Reload to try again.
      </div>
    )
  if (state.kind === 'missing') return <Unavailable slug={slug} email={state.email} />
  if (state.kind === 'locked') return <PasswordGate slug={slug} linkKey={key} onUnlocked={() => setAttempt((n) => n + 1)} />

  return <PageFrame page={state.page} email={state.email} onChange={(page) => setState({ ...state, page })} />
}

// A page shared by a link with a password. It says nothing about the page until the password is right.
function PasswordGate({ slug, linkKey, onUnlocked }: { slug: string; linkKey: string | null; onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!password) {
      setError('Enter the password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unlockPage(slug, password, linkKey)
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The password could not be checked. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box unavailable" aria-labelledby="locked-title">
          <span className="unavailable-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M6 9V7a4 4 0 1 1 8 0v2M5 9h10v8H5z" />
            </svg>
          </span>
          <h1 id="locked-title">This page needs a password</h1>
          <p className="auth-lede">Ask the person who sent you the link for it.</p>
          <form className="auth-form" onSubmit={onSubmit} noValidate>
            <label htmlFor="page-password">Password</label>
            <input
              id="page-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'page-password-error' : undefined}
              autoFocus
            />
            {error && (
              <p id="page-password-error" className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="button" disabled={busy}>
              {busy ? 'Opening' : 'Open page'}
            </button>
          </form>
        </section>
      </main>
    </div>
  )
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
            <svg viewBox="0 0 20 20">
              <path d="M6 9V7a4 4 0 1 1 8 0v2M5 9h10v8H5z" />
            </svg>
          </span>
          <h1 id="unavailable-title">This page isn't available</h1>
          {email ? (
            <>
              <p className="auth-lede">
                You're signed in as <strong>{email}</strong>, and this page isn't shared with that address. It may also have been deleted.
              </p>
              <p className="auth-lede">Ask the person who sent it to share it with {email}, or switch to the account it was shared with.</p>
              <div className="unavailable-actions">
                <button type="button" className="button" onClick={switchAccount}>
                  Switch account
                </button>
                <Link className="text-link" to="/app">
                  Go to your pages
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="auth-lede">It's private or it was deleted. If it was shared with you, log in with the email address it was sent to.</p>
              <div className="unavailable-actions">
                <Link className="button" to={back}>
                  Log in to open it
                </Link>
                <Link className="text-link" to="/">
                  What is The Artifact?
                </Link>
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
  // Comment counts change after the panel's requests finish, by then this render's page may be stale
  const pageRef = useRef(page)
  pageRef.current = page
  // One side panel at a time. Links in comment emails end in ?comments, which opens that one.
  const [panel, setPanel] = useState<'history' | 'comments' | 'views' | null>(() =>
    page.comments && new URLSearchParams(window.location.search).has('comments') ? 'comments' : null,
  )
  const toggle = (which: 'history' | 'comments' | 'views') => setPanel((p) => (p === which ? null : which))
  const historyButton = useRef<HTMLButtonElement>(null)
  const commentsButton = useRef<HTMLButtonElement>(null)
  const viewsButton = useRef<HTMLButtonElement>(null)
  // The panel took focus when it opened; closing it hands focus back to the button that opened it
  function closePanel() {
    const button = panel === 'history' ? historyButton : panel === 'views' ? viewsButton : commentsButton
    setPanel(null)
    button.current?.focus()
  }
  // Once opened, drop ?comments so Copy link hands on the page's address, with its key if it has one
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    if (!search.has('comments')) return
    search.delete('comments')
    navigate({ search: search.size ? `?${search}` : '' }, { replace: true })
  }, [navigate])
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const [announce, setAnnounce] = useState('')

  // Downloads what the frame shows, which can be an older version picked in the history
  const menu: MenuItem[] = [{ label: 'Download', download: downloadUrl(page.slug, viewing?.version) }]
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
          <span className="viewer-badge" data-visibility={page.visibility}>
            {VISIBILITY_LABEL[page.visibility]}
          </span>
          {page.comments && (
            <button
              ref={commentsButton}
              type="button"
              className="viewer-history viewer-comments"
              aria-expanded={panel === 'comments'}
              aria-controls="comments-panel"
              onClick={() => toggle('comments')}
            >
              Comments
              {page.comments.unread > 0 ? (
                <span className="viewer-count" data-unread="">
                  {page.comments.unread}
                  <span className="visually-hidden"> new</span>
                </span>
              ) : (
                page.comments.total > 0 && <span className="viewer-count">{page.comments.total}</span>
              )}
            </button>
          )}
          {page.canEdit && typeof page.views === 'number' && (
            <button
              ref={viewsButton}
              type="button"
              className="viewer-history viewer-comments"
              aria-expanded={panel === 'views'}
              aria-controls="views-panel"
              onClick={() => toggle('views')}
            >
              Views
              {page.views > 0 && <span className="viewer-views-count">{page.views}</span>}
            </button>
          )}
          {page.canEdit && (
            <button
              ref={historyButton}
              type="button"
              className="viewer-history"
              aria-expanded={panel === 'history'}
              aria-controls="history-panel"
              onClick={() => toggle('history')}
            >
              History
            </button>
          )}
          {page.canEdit ? (
            <button type="button" className="viewer-copy" onClick={() => setSharing(true)}>
              Share
            </button>
          ) : (
            <button type="button" className="viewer-copy" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          <PageMenu label="More actions" items={menu} />
        </div>
        <span className="visually-hidden" role="status">
          {copied ? 'Link copied' : announce}
        </span>
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
      <main id="main" className="viewer-body">
        <iframe
          key={viewing ? `v${viewing.version}` : 'current'}
          className="viewer-frame"
          title={viewing ? `${page.title}, version ${viewing.version}` : page.title}
          sandbox={FRAME_SANDBOX}
          src={versionUrl(page.slug, viewing ? viewing.version : page.version)}
        />
        {panel === 'history' && (
          <HistoryPanel slug={page.slug} currentVersion={page.version} selected={viewing?.version ?? page.version} onSelect={setViewing} onClose={closePanel} />
        )}
        {panel === 'views' && <ViewsPanel slug={page.slug} currentVersion={page.version} visibility={page.visibility} onClose={closePanel} />}
        {panel === 'comments' && page.comments && (
          <CommentsPanel
            slug={page.slug}
            currentVersion={page.version}
            onClose={closePanel}
            onSeen={() => onChange({ ...pageRef.current, comments: { total: pageRef.current.comments?.total ?? 0, unread: 0 } })}
            onTotalChange={(delta) => {
              const counts = pageRef.current.comments ?? { total: 0, unread: 0 }
              onChange({ ...pageRef.current, comments: { ...counts, total: Math.max(0, counts.total + delta) } })
            }}
          />
        )}
      </main>
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
