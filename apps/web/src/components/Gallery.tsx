import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { contentUrl, listArtifacts, type ArtifactSummary, type Visibility } from '../api'
import { timeAgo } from '../time'
import { DeleteDialog, PageMenu, RenameDialog, type MenuItem } from './PageActions'
import './Gallery.css'

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Restricted',
  organization: 'Organization',
  link: 'Anyone with the link',
}

// The size pages are laid out at before being scaled down into the card
const FRAME_WIDTH = 1280
const FRAME_HEIGHT = 720
const SEARCH_DELAY = 250

type List = { kind: 'loading' } | { kind: 'ready'; items: ArtifactSummary[] } | { kind: 'error' }
type Tab = 'workspace' | 'shared'
type Pending = { kind: 'rename' | 'delete'; page: ArtifactSummary } | null

type Props = {
  // 'personal' or an organization id
  workspaceId: string
  workspaceName: string
  email: string
  // Shown next to the workspace pages, e.g. the getting-started checklist
  aside?: ReactNode
  // How many pages the workspace has, ignoring any search
  onWorkspaceCount?: (count: number) => void
}

export function Gallery({ workspaceId, workspaceName, email, aside, onWorkspaceCount }: Props) {
  const [tab, setTab] = useState<Tab>('workspace')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [lists, setLists] = useState<Record<Tab, List>>({ workspace: { kind: 'loading' }, shared: { kind: 'loading' } })
  const [totals, setTotals] = useState<Record<Tab, number | null>>({ workspace: null, shared: null })
  const [pending, setPending] = useState<Pending>(null)
  const [announce, setAnnounce] = useState('')
  const countRef = useRef(onWorkspaceCount)
  useEffect(() => {
    countRef.current = onWorkspaceCount
  })

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), query.trim() ? SEARCH_DELAY : 0)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const abort = new AbortController()
    const load = (t: Tab, id: string) =>
      listArtifacts(id, search, abort.signal)
        .then((items) => {
          setLists((l) => ({ ...l, [t]: { kind: 'ready', items } }))
          if (!search) {
            setTotals((c) => ({ ...c, [t]: items.length }))
            if (t === 'workspace') countRef.current?.(items.length)
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) setLists((l) => ({ ...l, [t]: { kind: 'error' } }))
        })
    load('workspace', workspaceId)
    load('shared', 'shared')
    return () => abort.abort()
  }, [workspaceId, search])

  function update(slug: string, change: (a: ArtifactSummary) => ArtifactSummary | null) {
    setLists((l) => {
      const next = { ...l }
      for (const t of ['workspace', 'shared'] as Tab[]) {
        const list = l[t]
        if (list.kind === 'ready') {
          next[t] = { kind: 'ready', items: list.items.map((a) => (a.slug === slug ? change(a) : a)).filter((a): a is ArtifactSummary => a !== null) }
        }
      }
      return next
    })
  }

  function onRenamed(page: ArtifactSummary, title: string) {
    update(page.slug, (a) => ({ ...a, title, updatedAt: new Date().toISOString() }))
    setAnnounce(`Renamed to “${title}”.`)
  }

  function onDeleted(page: ArtifactSummary) {
    update(page.slug, () => null)
    // Only your own pages can be deleted, and those are listed in the workspace tab
    if (totals.workspace !== null) {
      const left = Math.max(0, totals.workspace - 1)
      setTotals((c) => ({ ...c, workspace: left }))
      countRef.current?.(left)
    }
    setPending(null)
    setAnnounce(`Deleted “${page.title}”.`)
  }

  const list = lists[tab]
  const items = list.kind === 'ready' ? list.items : []
  const searching = search.length > 0
  const total = totals[tab]
  const showSearch = searching || query.length > 0 || (total ?? 0) > 0
  const stale = query.trim() !== search
  const withAside = tab === 'workspace' && aside

  return (
    <>
      <div className="gallery-tabs" role="tablist" aria-label="Which pages">
        <button type="button" role="tab" aria-selected={tab === 'workspace'} onClick={() => setTab('workspace')}>
          {workspaceName}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'shared'} onClick={() => setTab('shared')}>
          Shared with you{totals.shared ? ` (${totals.shared})` : ''}
        </button>
      </div>

      {showSearch && (
        <div className="gallery-search" role="search">
          <label className="visually-hidden" htmlFor="gallery-search">Search pages by title</label>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 3a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM12.5 12.5 17 17" /></svg>
          <input
            id="gallery-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'workspace' ? `Search ${workspaceName}` : 'Search pages shared with you'}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <div className={withAside ? 'app-grid' : 'app-grid app-grid-full'}>
        {withAside}

        {list.kind === 'error' && <p className="auth-notice" role="alert">These pages could not be loaded. Reload to try again.</p>}

        {list.kind === 'ready' && items.length === 0 && searching && (
          <div className="gallery-no-match">
            <p>No pages match “{search}”.</p>
            <button type="button" className="text-link gallery-clear" onClick={() => setQuery('')}>Clear search</button>
          </div>
        )}

        {tab === 'shared' && list.kind === 'ready' && items.length === 0 && !searching && (
          <p className="gallery-note">Nothing has been shared with you yet. When someone adds {email} to a page, it shows up here.</p>
        )}

        {tab === 'workspace' && list.kind === 'ready' && items.length === 0 && !searching && (
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
          <ul className="gallery" aria-label={tab === 'workspace' ? `Pages in ${workspaceName}` : 'Pages shared with you'} aria-busy={stale || undefined}>
            {items.map((a) => (
              <li key={a.slug}>
                <Card page={a} onRename={() => setPending({ kind: 'rename', page: a })} onDelete={() => setPending({ kind: 'delete', page: a })} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="visually-hidden" role="status">
        {announce || (searching && list.kind === 'ready' ? `${items.length} ${items.length === 1 ? 'page matches' : 'pages match'}` : '')}
      </p>

      {pending?.kind === 'rename' && (
        <RenameDialog slug={pending.page.slug} title={pending.page.title} onClose={() => setPending(null)} onRenamed={(t) => onRenamed(pending.page, t)} />
      )}
      {pending?.kind === 'delete' && (
        <DeleteDialog slug={pending.page.slug} title={pending.page.title} onClose={() => setPending(null)} onDeleted={() => onDeleted(pending.page)} />
      )}
    </>
  )
}

function Card({ page: a, onRename, onDelete }: { page: ArtifactSummary; onRename: () => void; onDelete: () => void }) {
  const menu: MenuItem[] = [{ label: 'Open', to: `/a/${a.slug}` }]
  if (a.canEdit) menu.push({ label: 'Rename', onSelect: onRename })
  if (a.mine) menu.push({ label: 'Delete', onSelect: onDelete, danger: true })

  return (
    <div className="page-card">
      <Thumbnail slug={a.slug} version={a.version} />
      <Link className="page-card-link" to={`/a/${a.slug}`}>
        <strong>{a.title}</strong>
      </Link>
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
      {/* Open alone is what clicking the card does, so people who can only view get no menu */}
      {menu.length > 1 && <PageMenu className="page-card-menu" label={`More actions for ${a.title}`} items={menu} />}
    </div>
  )
}

// A live, scaled-down render of the page. It loads only near the viewport, can't be focused or
// clicked (the card link sits on top), and runs sandboxed like the viewer.
function Thumbnail({ slug, version }: { slug: string; version: number }) {
  const box = useRef<HTMLSpanElement>(null)
  const [scale, setScale] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScale(el.clientWidth / FRAME_WIDTH)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <span className="page-card-thumb" ref={box} data-loaded={loaded || undefined} aria-hidden="true">
      <span className="page-card-sketch">
        <span />
        <span />
        <span />
      </span>
      {scale > 0 && (
        <iframe
          src={contentUrl(slug, version)}
          title=""
          loading="lazy"
          sandbox="allow-scripts"
          tabIndex={-1}
          aria-hidden="true"
          width={FRAME_WIDTH}
          height={FRAME_HEIGHT}
          style={{ transform: `scale(${scale})` }}
          onLoad={() => setLoaded(true)}
        />
      )}
    </span>
  )
}
