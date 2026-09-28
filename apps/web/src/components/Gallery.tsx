import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { downloadUrl, listArtifacts, listFolders, thumbnailUrl, type ArtifactSummary, type FolderSummary, type Visibility } from '../api'
import { pollThumbnails, withFreshThumbnails } from '../thumbnailPoll'
import { timeAgo } from '../time'
import { DeleteFolderDialog, FolderBar, FolderIcon, FolderNameDialog, MoveDialog, type FolderFilter } from './Folders'
import { DeleteDialog, PageMenu, RenameDialog, type MenuItem } from './PageActions'
import { DuplicateDialog, MoveWorkspaceDialog } from './WorkspaceDialogs'
import './Gallery.css'

const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Restricted',
  organization: 'Organization',
  link: 'Anyone with the link',
}

const SEARCH_DELAY = 250
// Start loading the next pages this far before the end of the list comes into view
const SCROLL_AHEAD = '800px'

type Ready = {
  kind: 'ready'
  items: ArtifactSummary[]
  // Cursor for the next pages; null once everything is loaded
  next: string | null
  // How many match the current search and folder
  total: number | null
  more: 'idle' | 'loading' | 'error'
  // Loading again for another search or folder; the cards on screen are the old ones until then
  reloading?: boolean
}
type List = { kind: 'loading' } | Ready | { kind: 'error' }
type Tab = 'workspace' | 'shared'
type Pending =
  | { kind: 'rename' | 'delete' | 'move' | 'duplicate' | 'move-workspace'; page: ArtifactSummary }
  | { kind: 'new-folder' }
  | { kind: 'rename-folder' | 'delete-folder'; folder: FolderSummary }
  | null

type Props = {
  // 'personal' or an organization id. Give the gallery a key per workspace, so another one starts afresh.
  workspaceId: string
  workspaceName: string
  email: string
  // Shown next to the workspace pages, e.g. the getting-started checklist
  aside?: ReactNode
  // How many pages the workspace has, ignoring any search or folder
  onWorkspaceCount?: (count: number) => void
}

export function Gallery({ workspaceId, workspaceName, email, aside, onWorkspaceCount }: Props) {
  const [tab, setTab] = useState<Tab>('workspace')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FolderFilter>('all')
  const [folders, setFolders] = useState<FolderSummary[] | null>(null)
  const [lists, setLists] = useState<Record<Tab, List>>({ workspace: { kind: 'loading' }, shared: { kind: 'loading' } })
  const [totals, setTotals] = useState<Record<Tab, number | null>>({ workspace: null, shared: null })
  const [pending, setPending] = useState<Pending>(null)
  const [announce, setAnnounce] = useState('')
  const navigate = useNavigate()
  const countRef = useRef(onWorkspaceCount)
  const listsRef = useRef(lists)
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    countRef.current = onWorkspaceCount
    listsRef.current = lists
  })

  const folderParam = filter === 'all' ? undefined : filter
  const source = (t: Tab) => (t === 'workspace' ? { id: workspaceId, folder: folderParam } : { id: 'shared', folder: undefined })

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), query.trim() ? SEARCH_DELAY : 0)
    return () => clearTimeout(t)
  }, [query])

  function reloadFolders() {
    listFolders(workspaceId)
      .then((rows) => {
        setFolders(rows)
        // Someone else may have deleted the folder on screen
        setFilter((f) => (f === 'all' || f === 'none' || rows.some((r) => r.id === f) ? f : 'all'))
      })
      .catch(() => setFolders((f) => f ?? []))
  }

  useEffect(reloadFolders, [workspaceId])

  function firstPage(t: Tab, id: string, folder: string | undefined, signal: AbortSignal) {
    setLists((l) => {
      const cur = l[t]
      return { ...l, [t]: cur.kind === 'ready' ? { ...cur, reloading: true } : { kind: 'loading' } }
    })
    listArtifacts(id, { query: search, folder }, signal)
      .then(({ items, next, total }) => {
        setLists((l) => ({ ...l, [t]: { kind: 'ready', items, next, total, more: 'idle' } }))
        if (!search && !folder && total !== null) {
          setTotals((c) => ({ ...c, [t]: total }))
          if (t === 'workspace') countRef.current?.(total)
        }
      })
      .catch(() => {
        if (!signal.aborted) setLists((l) => ({ ...l, [t]: { kind: 'error' } }))
      })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: firstPage reads search, which is listed
  useEffect(() => {
    const abort = new AbortController()
    firstPage('workspace', workspaceId, folderParam, abort.signal)
    return () => abort.abort()
  }, [workspaceId, folderParam, search])

  // biome-ignore lint/correctness/useExhaustiveDependencies: firstPage reads search, which is listed
  useEffect(() => {
    const abort = new AbortController()
    firstPage('shared', 'shared', undefined, abort.signal)
    return () => abort.abort()
  }, [search])

  async function loadMore(t: Tab) {
    const l = listsRef.current[t]
    if (l.kind !== 'ready' || !l.next || l.more === 'loading') return
    const cursor = l.next
    const { id, folder } = source(t)
    // Only if the list is still the one this page follows (not reloaded for a new search meanwhile)
    const same = (cur: List): cur is Ready => cur.kind === 'ready' && cur.next === cursor
    setLists((prev) => (same(prev[t]) ? { ...prev, [t]: { ...prev[t], more: 'loading' } } : prev))
    try {
      const page = await listArtifacts(id, { query: search, folder, cursor })
      setLists((prev) => {
        const cur = prev[t]
        if (!same(cur)) return prev
        const seen = new Set(cur.items.map((a) => a.slug))
        return { ...prev, [t]: { ...cur, items: [...cur.items, ...page.items.filter((a) => !seen.has(a.slug))], next: page.next, more: 'idle' } }
      })
    } catch {
      setLists((prev) => (same(prev[t]) ? { ...prev, [t]: { ...prev[t], more: 'error' } } : prev))
    }
  }

  const list = lists[tab]
  const items = list.kind === 'ready' ? list.items : []
  const hasMore = list.kind === 'ready' && list.next !== null
  const loadingMore = list.kind === 'ready' && list.more === 'loading'
  const reloading = list.kind === 'ready' && list.reloading === true
  const moreFailed = list.kind === 'ready' && list.more === 'error'

  // Infinite scroll: the next pages load as the end of the list comes near
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMore reads the latest lists through a ref
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || moreFailed || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(tab), { rootMargin: SCROLL_AHEAD })
    observer.observe(el)
    return () => observer.disconnect()
  }, [tab, hasMore, moreFailed, items.length])

  // Cards on screen whose screenshot is still being rendered on the server
  const waiting = items.some((a) => a.thumbnailState === 'pending')

  // biome-ignore lint/correctness/useExhaustiveDependencies: source only reads workspaceId and folderParam, which are listed
  useEffect(() => {
    if (!waiting) return
    const t = tab
    const { id, folder } = source(t)
    const abort = new AbortController()
    const stop = pollThumbnails({
      refresh: async () => {
        // The newest pages are the ones still being rendered
        const fresh = (await listArtifacts(id, { query: search, folder }, abort.signal)).items
        setLists((l) => {
          const current = l[t]
          return current.kind === 'ready' ? { ...l, [t]: { ...current, items: withFreshThumbnails(current.items, fresh) } } : l
        })
        return fresh.some((a) => a.thumbnailState === 'pending')
      },
    })
    return () => {
      stop()
      abort.abort()
    }
  }, [waiting, tab, workspaceId, folderParam, search])

  function update(slug: string, change: (a: ArtifactSummary) => ArtifactSummary | null) {
    setLists((l) => {
      const next = { ...l }
      for (const t of ['workspace', 'shared'] as Tab[]) {
        const list = l[t]
        if (list.kind === 'ready') {
          const items = list.items.map((a) => (a.slug === slug ? change(a) : a)).filter((a): a is ArtifactSummary => a !== null)
          const gone = list.items.length - items.length
          next[t] = { ...list, items, total: list.total === null ? null : list.total - gone }
        }
      }
      return next
    })
  }

  function onRenamed(page: ArtifactSummary, title: string) {
    update(page.slug, (a) => ({ ...a, title, updatedAt: new Date().toISOString() }))
    setAnnounce(`Renamed to “${title}”.`)
  }

  // A page that left the workspace, deleted or moved to another one. Both are offered in the workspace tab only, so its count goes down.
  function onGone(page: ArtifactSummary, message: string) {
    update(page.slug, () => null)
    if (totals.workspace !== null) {
      const left = Math.max(0, totals.workspace - 1)
      setTotals((c) => ({ ...c, workspace: left }))
      countRef.current?.(left)
    }
    if (page.folder) reloadFolders()
    setPending(null)
    setAnnounce(message)
  }

  const onDeleted = (page: ArtifactSummary) => onGone(page, `Deleted “${page.title}”.`)

  function onMoved(page: ArtifactSummary, folder: { id: string; name: string } | null) {
    // A page that left the folder on screen leaves the list too
    const stays = filter === 'all' || (filter === 'none' ? folder === null : folder?.id === filter)
    update(page.slug, (a) => (stays ? { ...a, folder } : null))
    reloadFolders()
    setAnnounce(folder ? `Moved “${page.title}” to ${folder.name}.` : `“${page.title}” is in no folder now.`)
  }

  function onFolderSaved(folder: { id: string; name: string }, created: boolean) {
    reloadFolders()
    if (created) {
      setFilter(folder.id)
      setAnnounce(`Created the folder ${folder.name}.`)
      return
    }
    setLists((l) => {
      const w = l.workspace
      if (w.kind !== 'ready') return l
      return { ...l, workspace: { ...w, items: w.items.map((a) => (a.folder?.id === folder.id ? { ...a, folder } : a)) } }
    })
    setAnnounce(`Renamed the folder to ${folder.name}.`)
  }

  function onFolderDeleted(folder: FolderSummary) {
    setPending(null)
    setLists((l) => {
      const w = l.workspace
      if (w.kind !== 'ready') return l
      return { ...l, workspace: { ...w, items: w.items.map((a) => (a.folder?.id === folder.id ? { ...a, folder: null } : a)) } }
    })
    if (filter === folder.id) setFilter('all')
    reloadFolders()
    setAnnounce(`Deleted the folder ${folder.name}. Its pages are in no folder now.`)
  }

  const searching = search.length > 0
  const total = totals[tab]
  const showSearch = searching || query.length > 0 || (total ?? 0) > 0
  const stale = query.trim() !== search
  const withAside = tab === 'workspace' && aside
  const inFolder = tab === 'workspace' && filter !== 'all'
  const current = tab === 'workspace' && folders ? folders.find((f) => f.id === filter) : undefined
  const showFolders = tab === 'workspace' && folders !== null && (folders.length > 0 || (totals.workspace ?? 0) > 0)
  const empty = list.kind === 'ready' && items.length === 0

  // Tabs in the WAI-ARIA pattern: one tab stop, arrow keys switch between them
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const next = e.key === 'ArrowRight' || e.key === 'End' ? 'shared' : e.key === 'ArrowLeft' || e.key === 'Home' ? 'workspace' : null
    if (!next) return
    e.preventDefault()
    setTab(next)
    e.currentTarget.querySelector<HTMLElement>(`#gallery-tab-${next}`)?.focus()
  }

  return (
    <>
      <div className="gallery-tabs" role="tablist" aria-label="Which pages" onKeyDown={onTabKey}>
        {(['workspace', 'shared'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`gallery-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="gallery-panel"
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
          >
            {t === 'workspace' ? workspaceName : `Shared with you${totals.shared ? ` (${totals.shared})` : ''}`}
          </button>
        ))}
      </div>

      <div id="gallery-panel" role="tabpanel" aria-labelledby={`gallery-tab-${tab}`}>
        {showSearch && (
          <div className="gallery-search" role="search">
            <label className="visually-hidden" htmlFor="gallery-search">
              Search pages by title
            </label>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M8.5 3a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM12.5 12.5 17 17" />
            </svg>
            <input
              id="gallery-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'workspace' ? `Search ${current?.name ?? workspaceName}` : 'Search pages shared with you'}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        {showFolders && (
          <FolderBar folders={folders} total={totals.workspace} selected={filter} onSelect={setFilter} onNew={() => setPending({ kind: 'new-folder' })} />
        )}

        {current && (
          <div className="folder-head">
            <h2>
              <FolderIcon />
              {current.name}
            </h2>
            <button type="button" className="text-link gallery-clear" onClick={() => setPending({ kind: 'rename-folder', folder: current })}>
              Rename
            </button>
            <button type="button" className="text-link gallery-clear" onClick={() => setPending({ kind: 'delete-folder', folder: current })}>
              Delete folder
            </button>
          </div>
        )}

        <div className={withAside ? 'app-grid' : 'app-grid app-grid-full'}>
          {withAside}

          {list.kind === 'error' && (
            <p className="auth-notice" role="alert">
              These pages could not be loaded. Reload to try again.
            </p>
          )}

          {empty && searching && (
            <div className="gallery-no-match">
              <p>
                No pages {current ? `in ${current.name} ` : ''}match “{search}”.
              </p>
              <button type="button" className="text-link gallery-clear" onClick={() => setQuery('')}>
                Clear search
              </button>
            </div>
          )}

          {empty && !searching && inFolder && (
            <p className="gallery-note">
              {filter === 'none'
                ? 'Every page here is in a folder.'
                : "Nothing in this folder yet. Choose Move to folder in a page's menu, or ask your agent to publish into it."}
            </p>
          )}

          {tab === 'shared' && empty && !searching && (
            <p className="gallery-note">Nothing has been shared with you yet. When someone adds {email} to a page, it shows up here.</p>
          )}

          {tab === 'workspace' && empty && !searching && !inFolder && (
            <section className="gallery-empty" aria-label="Your pages">
              <div className="ghost-grid" aria-hidden="true">
                <div className="ghost ghost-first">
                  <span>Your first page lands here</span>
                </div>
                <div className="ghost" />
                <div className="ghost" />
                <div className="ghost" />
              </div>
              <p>No pages yet. When your agent publishes, each page appears here with its link.</p>
            </section>
          )}

          {items.length > 0 && (
            <div className="gallery-list">
              <ul
                className="gallery"
                aria-label={tab === 'workspace' ? `Pages in ${current?.name ?? workspaceName}` : 'Pages shared with you'}
                aria-busy={stale || reloading || loadingMore || undefined}
                data-stale={stale || reloading || undefined}
              >
                {items.map((a) => (
                  <li key={a.slug}>
                    <Card
                      page={a}
                      showFolder={tab === 'workspace' && filter === 'all'}
                      canMove={tab === 'workspace' && a.canEdit}
                      canMoveWorkspace={tab === 'workspace' && (a.canMove ?? false)}
                      onRename={() => setPending({ kind: 'rename', page: a })}
                      onDelete={() => setPending({ kind: 'delete', page: a })}
                      onMove={() => setPending({ kind: 'move', page: a })}
                      onDuplicate={() => setPending({ kind: 'duplicate', page: a })}
                      onMoveWorkspace={() => setPending({ kind: 'move-workspace', page: a })}
                    />
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="gallery-more" ref={sentinel}>
                  {loadingMore ? (
                    <p className="gallery-loading">Loading more pages…</p>
                  ) : moreFailed ? (
                    <>
                      <p>More pages could not be loaded.</p>
                      <button type="button" className="button button-quiet" onClick={() => loadMore(tab)}>
                        Try again
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button-quiet" onClick={() => loadMore(tab)}>
                      Show more pages
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="visually-hidden" role="status">
        {announce ||
          (searching && list.kind === 'ready'
            ? `${list.total ?? items.length} ${(list.total ?? items.length) === 1 ? 'page matches' : 'pages match'}`
            : loadingMore
              ? 'Loading more pages'
              : '')}
      </p>

      {pending?.kind === 'rename' && (
        <RenameDialog slug={pending.page.slug} title={pending.page.title} onClose={() => setPending(null)} onRenamed={(t) => onRenamed(pending.page, t)} />
      )}
      {pending?.kind === 'delete' && (
        <DeleteDialog slug={pending.page.slug} title={pending.page.title} onClose={() => setPending(null)} onDeleted={() => onDeleted(pending.page)} />
      )}
      {pending?.kind === 'move' && (
        <MoveDialog
          workspaceId={workspaceId}
          slug={pending.page.slug}
          title={pending.page.title}
          current={pending.page.folder?.id ?? null}
          folders={folders ?? []}
          onClose={() => setPending(null)}
          onMoved={(folder) => onMoved(pending.page, folder)}
        />
      )}
      {pending?.kind === 'duplicate' && (
        <DuplicateDialog
          slug={pending.page.slug}
          title={pending.page.title}
          preferred={workspaceId}
          onClose={() => setPending(null)}
          onDuplicated={(copy) => navigate(`/a/${copy.slug}`)}
        />
      )}
      {pending?.kind === 'move-workspace' && (
        <MoveWorkspaceDialog
          slug={pending.page.slug}
          title={pending.page.title}
          current={workspaceId}
          isOwner={pending.page.mine}
          visibility={pending.page.visibility}
          onClose={() => setPending(null)}
          onMoved={(_, name) => onGone(pending.page, `Moved “${pending.page.title}” to ${name}.`)}
        />
      )}
      {pending?.kind === 'new-folder' && (
        <FolderNameDialog workspaceId={workspaceId} onClose={() => setPending(null)} onSaved={(f) => onFolderSaved(f, true)} />
      )}
      {pending?.kind === 'rename-folder' && (
        <FolderNameDialog workspaceId={workspaceId} folder={pending.folder} onClose={() => setPending(null)} onSaved={(f) => onFolderSaved(f, false)} />
      )}
      {pending?.kind === 'delete-folder' && (
        <DeleteFolderDialog folder={pending.folder} onClose={() => setPending(null)} onDeleted={() => onFolderDeleted(pending.folder)} />
      )}
    </>
  )
}

type CardProps = {
  page: ArtifactSummary
  showFolder: boolean
  canMove: boolean
  canMoveWorkspace: boolean
  onRename: () => void
  onDelete: () => void
  onMove: () => void
  onDuplicate: () => void
  onMoveWorkspace: () => void
}

function Card({ page: a, showFolder, canMove, canMoveWorkspace, onRename, onDelete, onMove, onDuplicate, onMoveWorkspace }: CardProps) {
  const menu: MenuItem[] = [
    { label: 'Open', to: `/a/${a.slug}` },
    { label: 'Download', download: downloadUrl(a.slug) },
  ]
  if (a.canEdit) menu.push({ label: 'Rename', onSelect: onRename })
  menu.push({ label: 'Duplicate', onSelect: onDuplicate })
  if (canMove) menu.push({ label: 'Move to folder', onSelect: onMove })
  if (canMoveWorkspace) menu.push({ label: 'Move to workspace…', onSelect: onMoveWorkspace })
  if (a.mine) menu.push({ label: 'Delete', onSelect: onDelete, danger: true })

  return (
    <div className="page-card">
      <Thumbnail key={a.version} slug={a.slug} version={a.version} ready={a.thumbnail} />
      <Link className="page-card-link" to={`/a/${a.slug}`}>
        <strong>{a.title}</strong>
      </Link>
      <span className="page-card-meta">
        {a.role ? `Shared by ${a.owner}, updated ` : 'Updated '}
        {timeAgo(a.updatedAt)}
        {a.mine || a.role ? '' : ` by ${a.owner}`}
        {a.version > 1 ? `, version ${a.version}` : ''}
      </span>
      <span className="page-card-tags">
        {showFolder && a.folder && (
          <span className="page-card-folder">
            <FolderIcon />
            {a.folder.name}
          </span>
        )}
        {a.role ? <span>{a.role === 'editor' ? 'Editor' : 'Viewer'}</span> : <span data-visibility={a.visibility}>{VISIBILITY_LABEL[a.visibility]}</span>}
        {a.publishedWith && <span>{a.publishedWith}</span>}
        {a.comments ? <CommentCount total={a.comments} unread={a.unreadComments ?? 0} /> : null}
      </span>
      <PageMenu className="page-card-menu" label={`More actions for ${a.title}`} items={menu} />
    </div>
  )
}

// New ones are those others wrote since you last opened the page's comments
function CommentCount({ total, unread }: { total: number; unread: number }) {
  return (
    <span className="page-card-comments" data-unread={unread ? '' : undefined}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 4.5h14v9H8l-4 3v-3H3z" />
      </svg>
      {unread ? `${unread} new` : total}
      <span className="visually-hidden">{unread ? ` of ${total} ${total === 1 ? 'comment' : 'comments'}` : total === 1 ? ' comment' : ' comments'}</span>
    </span>
  )
}

// A screenshot of the current version, rendered on the server after publishing. Until it exists (or
// if it can't be rendered) the card shows a drawn sketch of a page instead.
function Thumbnail({ slug, version, ready }: { slug: string; version: number; ready: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <span className="page-card-thumb" data-loaded={loaded || undefined} aria-hidden="true">
      <span className="page-card-sketch">
        <span />
        <span />
        <span />
      </span>
      {ready && !failed && (
        <img
          src={thumbnailUrl(slug, version)}
          alt=""
          loading="lazy"
          decoding="async"
          width={640}
          height={360}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}
