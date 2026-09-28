import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  addComment,
  deleteComment,
  editComment,
  listComments,
  markCommentsSeen,
  MAX_COMMENT_LENGTH,
  resolveComment,
  type CommentAnchor,
  type CommentThread,
  type PageComment,
} from '../api'
import { timeAgo } from '../time'
import type { AnchoredThread, FrameHelper, PinStatus } from './PagePins'
import './HistoryPanel.css'
import './CommentsPanel.css'

const exactTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

type Props = {
  slug: string
  currentVersion: number
  onClose: () => void
  // Every comment is read once the panel has loaded them
  onSeen: () => void
  // Comments added (1) or removed (minus how many), for the count on the button
  onTotalChange: (delta: number) => void
  // The comment helper in the page's frame, for pinning comments to elements and showing the pins
  helper?: FrameHelper
  // A pin chosen on the page: its thread is scrolled to and focused
  focusThread?: { id: string } | null
}

const excerpt = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text)

// Open threads about an element, numbered in the order they are listed, as their pins are
function anchoredThreads(threads: CommentThread[] | null): AnchoredThread[] {
  return (threads ?? [])
    .filter((t): t is CommentThread & { anchor: CommentAnchor } => t.anchor !== null && !t.resolved)
    .map((t, i) => ({ id: t.id, anchor: t.anchor, number: i + 1, label: excerpt(t.body.replace(/\s+/g, ' ')) }))
}

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

// Comments on the page, one level of threads, oldest first. Bodies are plain text rendered as text
// (never as HTML): they come from anyone who can open the page and show inside the app, outside the
// page's sandbox.
export function CommentsPanel({ slug, currentVersion, onClose, onSeen, onTotalChange, helper, focusThread }: Props) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [seenAt, setSeenAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [announce, setAnnounce] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const newCommentId = useId()
  const pinButtonId = useId()

  const anchored = anchoredThreads(threads)
  const numbers = new Map(anchored.map((a) => [a.id, a]))
  const setAnchored = helper?.setAnchored
  const anchoredKey = JSON.stringify(anchored)
  // biome-ignore lint/correctness/useExhaustiveDependencies: anchoredKey stands for anchored
  useEffect(() => setAnchored?.(anchored), [anchoredKey, setAnchored])
  useEffect(() => () => setAnchored?.([]), [setAnchored])

  // When picking ends, focus comes back to the panel: to the comment being written once an element
  // is pinned, or to the button that started it
  const picking = helper?.picking ?? false
  const hasDraft = Boolean(helper?.draft)
  const wasPicking = useRef(false)
  useEffect(() => {
    if (wasPicking.current && !picking) document.getElementById(hasDraft ? newCommentId : pinButtonId)?.focus()
    wasPicking.current = picking
  }, [picking, hasDraft, newCommentId, pinButtonId])

  useEffect(() => {
    if (!focusThread) return
    const item = list.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(focusThread.id)}"]`)
    item?.scrollIntoView({ block: 'nearest' })
    item?.focus()
  }, [focusThread])

  useEffect(() => {
    heading.current?.focus()
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per page; onSeen changes on every render of the viewer
  useEffect(() => {
    let active = true
    listComments(slug)
      .then((l) => {
        if (!active) return
        setThreads(l.threads)
        setNext(l.next)
        setSeenAt(l.seenAt)
        markCommentsSeen(slug)
          .then(() => active && onSeen())
          .catch(() => {})
      })
      .catch((err) => active && setError(errorText(err, 'The comments could not be loaded.')))
    return () => {
      active = false
    }
  }, [slug])

  async function loadMore() {
    if (!next) return
    setLoadingMore(true)
    try {
      const l = await listComments(slug, next)
      setThreads((t) => [...(t ?? []), ...l.threads])
      setNext(l.next)
    } catch (err) {
      setError(errorText(err, 'More comments could not be loaded.'))
    } finally {
      setLoadingMore(false)
    }
  }

  function updateThread(id: string, change: (t: CommentThread) => CommentThread | null) {
    setThreads((ts) => (ts ?? []).flatMap((t) => (t.id === id ? (change(t) ?? []) : [t])))
  }

  async function start(body: string) {
    const draft = helper?.draft
    const anchor = draft
      ? { version: draft.version, selector: draft.selector, snippet: draft.snippet, path: draft.path, ...(draft.rect ? { rect: draft.rect } : {}) }
      : undefined
    const created = await addComment(slug, body, { anchor })
    helper?.clearDraft()
    setThreads((ts) => [...(ts ?? []), { ...created, resolved: null, canResolve: true, replies: [] }])
    onTotalChange(1)
    setAnnounce('Comment added.')
    requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }))
  }

  const isNew = (c: PageComment) => !c.mine && (seenAt === null || c.createdAt > seenAt)

  return (
    <aside
      id="comments-panel"
      className="comments-panel"
      aria-labelledby="comments-title"
      data-picking={picking || undefined}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="comments-head">
        <h2 id="comments-title" ref={heading} tabIndex={-1}>
          Comments
        </h2>
        <button type="button" className="history-close" onClick={onClose} aria-label="Close comments">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>
      <div className="comments-scroll" ref={list}>
        {error && (
          <p className="history-error" role="alert">
            {error}
          </p>
        )}
        {!threads && !error && (
          <p className="history-note" role="status">
            Loading comments
          </p>
        )}
        {threads && threads.length === 0 && (
          <p className="history-note">No comments yet. People who can open this page can leave one here, and agents read them.</p>
        )}
        {threads && threads.length > 0 && (
          <ol className="comments-list">
            {threads.map((t) => (
              <Thread
                key={t.id}
                slug={slug}
                thread={t}
                currentVersion={currentVersion}
                isNew={isNew}
                onChange={(change) => updateThread(t.id, change)}
                onTotalChange={onTotalChange}
                onAnnounce={setAnnounce}
                pin={
                  t.anchor
                    ? { number: numbers.get(t.id)?.number ?? null, status: helper && numbers.has(t.id) ? helper.status(numbers.get(t.id)!) : undefined }
                    : null
                }
                onShow={helper ? () => helper.show(t.id) : undefined}
              />
            ))}
          </ol>
        )}
        {next && (
          <button type="button" className="button button-quiet comments-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading' : 'Show more comments'}
          </button>
        )}
      </div>
      <div className="comments-compose">
        <Composer
          id={newCommentId}
          label="New comment"
          placeholder="Add a comment"
          submitLabel="Comment"
          onSubmit={start}
          extra={helper?.path ? <PinChoice helper={helper} buttonId={pinButtonId} /> : null}
        />
      </div>
      <span className="visually-hidden" role="status">
        {announce}
      </span>
    </aside>
  )
}

type ThreadProps = {
  slug: string
  thread: CommentThread
  currentVersion: number
  isNew: (c: PageComment) => boolean
  onChange: (change: (t: CommentThread) => CommentThread | null) => void
  onTotalChange: (delta: number) => void
  onAnnounce: (message: string) => void
  // For a thread about an element: its number while open, and where its element is on the page shown
  pin: { number: number | null; status: PinStatus | undefined } | null
  onShow?: () => void
}

function Thread({ slug, thread, currentVersion, isNew, onChange, onTotalChange, onAnnounce, pin, onShow }: ThreadProps) {
  const [replying, setReplying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setResolved(resolved: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await resolveComment(slug, thread.id, resolved)
      onChange((t) => ({ ...t, resolved: res.resolved }))
      setExpanded(false)
      onAnnounce(resolved ? 'Thread resolved.' : 'Thread reopened.')
    } catch (err) {
      setError(errorText(err, 'The thread could not be changed. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function reply(body: string) {
    const created = await addComment(slug, body, { replyTo: thread.id })
    // A reply reopens a resolved thread, on the server too
    onChange((t) => ({ ...t, resolved: null, replies: [...t.replies, created] }))
    onTotalChange(1)
    setReplying(false)
    onAnnounce('Reply added.')
  }

  if (thread.resolved && !expanded) {
    return (
      <li className="comment-thread" data-resolved="">
        <div className="comment-resolved">
          <p>
            <span className="comment-resolved-label">Resolved{thread.resolved.by ? ` by ${thread.resolved.by}` : ''}</span>
            <span className="comment-snippet">{thread.body}</span>
          </p>
          <button type="button" className="comment-action" aria-expanded={false} onClick={() => setExpanded(true)}>
            Show
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="comment-thread" data-resolved={thread.resolved ? '' : undefined} data-thread={thread.id} tabIndex={-1}>
      {thread.anchor && pin && <AnchorNote anchor={thread.anchor} pin={pin} onShow={onShow} />}
      {thread.resolved && (
        <p className="comment-resolved-note">
          Resolved{thread.resolved.by ? ` by ${thread.resolved.by}` : ''} {timeAgo(thread.resolved.at)}
          <button type="button" className="comment-action" aria-expanded={true} onClick={() => setExpanded(false)}>
            Hide
          </button>
        </p>
      )}
      <Item
        slug={slug}
        comment={thread}
        currentVersion={currentVersion}
        isNew={isNew(thread)}
        replies={thread.replies.length}
        onEdited={(c) => onChange((t) => ({ ...t, ...c }))}
        onDeleted={() => {
          onChange(() => null)
          onTotalChange(-(1 + thread.replies.length))
          onAnnounce('Comment deleted.')
        }}
      >
        <button type="button" className="comment-action" onClick={() => setReplying(true)}>
          Reply
        </button>
        {thread.canResolve && (
          <button type="button" className="comment-action" onClick={() => setResolved(!thread.resolved)} disabled={busy}>
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
      </Item>
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      {thread.replies.length > 0 && (
        <ol className="comment-replies">
          {thread.replies.map((r) => (
            <li key={r.id}>
              <Item
                slug={slug}
                comment={r}
                currentVersion={currentVersion}
                isNew={isNew(r)}
                replies={0}
                onEdited={(c) => onChange((t) => ({ ...t, replies: t.replies.map((x) => (x.id === c.id ? c : x)) }))}
                onDeleted={() => {
                  onChange((t) => ({ ...t, replies: t.replies.filter((x) => x.id !== r.id) }))
                  onTotalChange(-1)
                  onAnnounce('Reply deleted.')
                }}
              />
            </li>
          ))}
        </ol>
      )}
      {replying && (
        <div className="comment-reply-form">
          <Composer label="Reply" placeholder="Reply" submitLabel="Reply" autoFocus onSubmit={reply} onCancel={() => setReplying(false)} />
        </div>
      )}
    </li>
  )
}

type ItemProps = {
  slug: string
  comment: PageComment
  currentVersion: number
  isNew: boolean
  // Replies that go with it when it is deleted
  replies: number
  onEdited: (c: PageComment) => void
  onDeleted: () => void
  children?: ReactNode
}

function Item({ slug, comment: c, currentVersion, isNew, replies, onEdited, onDeleted, children }: ItemProps) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(body: string) {
    onEdited(await editComment(slug, c.id, body))
    setEditing(false)
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await deleteComment(slug, c.id)
      onDeleted()
    } catch (err) {
      setError(errorText(err, 'The comment could not be deleted. Try again.'))
      setBusy(false)
    }
  }

  const version = c.version === currentVersion ? `on version ${c.version}` : `on version ${c.version} (now ${currentVersion})`

  return (
    <article className="comment" data-new={isNew || undefined}>
      <p className="comment-byline">
        <strong>{c.author ?? 'Deleted account'}</strong>
        {c.postedWith && <span className="comment-agent">via {c.postedWith}</span>}
        {isNew && <span className="comment-new">New</span>}
      </p>
      <p className="comment-meta">
        <time dateTime={c.createdAt} title={exactTime.format(new Date(c.createdAt))}>
          {timeAgo(c.createdAt)}
        </time>
        , {version}
        {c.editedAt ? ', edited' : ''}
      </p>
      {editing ? (
        <Composer label="Edit comment" initial={c.body} submitLabel="Save" autoFocus onSubmit={save} onCancel={() => setEditing(false)} />
      ) : (
        <p className="comment-body">{c.body}</p>
      )}
      {confirming ? (
        <div className="comment-confirm" role="group" aria-label="Delete comment">
          <span>{replies ? `Delete this comment and its ${replies === 1 ? 'reply' : `${replies} replies`}?` : 'Delete this comment?'}</span>
          <button type="button" className="comment-action comment-danger" onClick={remove} disabled={busy}>
            {busy ? 'Deleting' : 'Delete'}
          </button>
          <button type="button" className="comment-action" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        !editing && (
          <div className="comment-actions">
            {children}
            {c.canEdit && (
              <button type="button" className="comment-action" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {c.canDelete && (
              <button type="button" className="comment-action" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )}
          </div>
        )
      )}
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

type ComposerProps = {
  id?: string
  label: string
  placeholder?: string
  initial?: string
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
  // More controls next to the submit button
  extra?: ReactNode
}

function Composer({ id, label, placeholder, initial = '', submitLabel, autoFocus, onSubmit, onCancel, extra }: ComposerProps) {
  const [body, setBody] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) field.current?.focus()
  }, [autoFocus])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!body.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(body)
      setBody('')
    } catch (err) {
      setError(errorText(err, 'The comment could not be saved. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
    // Escape closes an edit or reply first, not the whole panel
    if (e.key === 'Escape' && onCancel) {
      e.stopPropagation()
      onCancel()
    }
  }

  const left = MAX_COMMENT_LENGTH - body.length
  const errorId = useId()

  return (
    <form className="comment-form" onSubmit={submit}>
      <textarea
        id={id}
        ref={field}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        maxLength={MAX_COMMENT_LENGTH}
        rows={initial ? 4 : 2}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {left < 500 && <span className="comment-left">{left} characters left</span>}
      {error && (
        <p id={errorId} className="history-error" role="alert">
          {error}
        </p>
      )}
      <div className="comment-form-actions">
        {extra}
        {onCancel && (
          <button type="button" className="comment-action" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="button comment-submit" disabled={busy || !body.trim()}>
          {busy ? 'Saving' : submitLabel}
        </button>
      </div>
    </form>
  )
}

// Pinning the comment being written to an element of the page, or what it is pinned to
function PinChoice({ helper, buttonId }: { helper: FrameHelper; buttonId: string }) {
  if (helper.draft) {
    return (
      <p className="comment-pinned">
        <span className="comment-pinned-text">{helper.draft.snippet ? `Pinned to “${helper.draft.snippet}”` : 'Pinned to an element'}</span>
        <button type="button" className="comment-action" onClick={helper.clearDraft}>
          Unpin
        </button>
      </p>
    )
  }
  if (helper.picking) {
    return (
      <p className="comment-pinned">
        <span className="comment-pinned-text">Choosing an element on the page</span>
        <button type="button" className="comment-action" onClick={helper.stopPick}>
          Cancel
        </button>
      </p>
    )
  }
  return (
    <button id={buttonId} type="button" className="comment-action comment-pin-start" onClick={helper.startPick}>
      Pin to an element
    </button>
  )
}

// What a thread is about, and whether its element is still on the page
function AnchorNote({ anchor, pin, onShow }: { anchor: CommentAnchor; pin: { number: number | null; status: PinStatus | undefined }; onShow?: () => void }) {
  const what = anchor.snippet ? `“${anchor.snippet}”` : 'an element'
  return (
    <div className="comment-anchor">
      {pin.number !== null && (
        <span className="comment-pin" aria-hidden="true">
          {pin.number}
        </span>
      )}
      <p>
        {pin.status === 'changed' ? (
          <>The element this comment is about has changed. It was {what}.</>
        ) : pin.status === 'elsewhere' ? (
          <>
            About {what} in {anchor.path}
          </>
        ) : (
          <>About {what}</>
        )}
        {pin.number !== null && <span className="visually-hidden">, pin {pin.number} on the page</span>}
      </p>
      {pin.status === 'shown' && onShow && (
        <button type="button" className="comment-action" onClick={onShow}>
          Show on page
        </button>
      )}
    </div>
  )
}
