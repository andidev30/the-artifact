import { Hono, type Context } from 'hono'
import { findBySlug } from '../artifacts.js'
import { requireUser, type AuthEnv } from '../auth/session.js'
import {
  addComment,
  canDeleteComment,
  canEditComment,
  canResolve,
  checkAnchor,
  checkBody,
  CommentCursorError,
  commentAccess,
  CommentError,
  deleteComment,
  editComment,
  findComment,
  lastSeen,
  listThreads,
  markSeen,
  MAX_THREADS_PER_PAGE,
  setResolved,
  threadOf,
  type ListedComment,
  type Thread,
} from '../comments.js'
import type { Comment } from '../db/schema.js'
import { limitRequest } from '../limits.js'
import { linkPassFor } from '../links.js'

// Mounted at /api/artifacts/:slug/comments. Signed-out visitors of a link-shared page don't see
// comments: they can be a team's internal feedback on a page it shows to outsiders.
export const comments = new Hono<AuthEnv>()

comments.use(requireUser)

async function load(c: Context<AuthEnv>) {
  const artifact = await findBySlug(c.req.param('slug')!)
  const access = artifact ? await commentAccess(artifact, c.get('user')!, await linkPassFor(c, artifact)) : null
  return artifact && access ? { artifact, ...access } : null
}

function view(comment: ListedComment, userId: string, moderator: boolean) {
  const mine = comment.authorId === userId
  return {
    id: comment.id,
    body: comment.body,
    version: comment.version,
    author: comment.authorLabel,
    mine,
    postedWith: comment.postedWith,
    anchor: comment.anchor,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    canEdit: mine,
    canDelete: mine || moderator,
  }
}

function threadView(t: Thread, userId: string, moderator: boolean) {
  return {
    ...view(t, userId, moderator),
    resolved: t.resolvedAt ? { at: t.resolvedAt, by: t.resolvedByLabel } : null,
    canResolve: moderator || t.authorId === userId,
    replies: t.replies.map((r) => view(r, userId, moderator)),
  }
}

// A comment just written or changed, in the same shape as in the list
function single(comment: Comment, user: { id: string; name: string | null; email: string }, moderator: boolean) {
  return view({ ...comment, authorLabel: user.name ?? user.email, resolvedByLabel: null }, user.id, moderator)
}

// Every thread, resolved ones included, oldest first; ?cursor= for the next ones. seenAt is when this
// person last opened the comments, so the app can mark what is new.
comments.get('/', async (c) => {
  const page = await load(c)
  if (!page) return c.json({ error: 'Not found' }, 404)
  const user = c.get('user')!
  try {
    const [{ threads, next }, seenAt] = await Promise.all([
      listThreads(page.artifact, { includeResolved: true, cursor: c.req.query('cursor') || undefined, limit: MAX_THREADS_PER_PAGE }),
      lastSeen(user.id, page.artifact),
    ])
    return c.json({
      threads: threads.map((t) => threadView(t, user.id, page.moderator)),
      next,
      seenAt,
      currentVersion: page.artifact.currentVersion,
    })
  } catch (err) {
    if (err instanceof CommentCursorError) return c.json({ error: err.message, field: 'cursor' }, 400)
    throw err
  }
})

// { body } starts a thread, { body, anchor } one about an element of the page (see checkAnchor);
// { body, replyTo: <comment id> } replies in the thread of that comment
comments.post('/', async (c) => {
  const page = await load(c)
  if (!page) return c.json({ error: 'Not found' }, 404)
  const user = c.get('user')!
  const input = (await c.req.json().catch(() => ({}))) as { body?: unknown; replyTo?: unknown; anchor?: unknown }
  const checked = checkBody(input.body)
  if ('error' in checked) return c.json({ error: checked.error, field: 'body' }, 400)
  const anchored = checkAnchor(input.anchor, page.artifact.currentVersion)
  if ('error' in anchored) return c.json({ error: anchored.error, field: 'anchor' }, 400)
  const hasReplyTo = input.replyTo !== undefined && input.replyTo !== null
  if (hasReplyTo && anchored.anchor) return c.json({ error: "A reply can't be pinned to an element. Start a new comment instead.", field: 'anchor' }, 400)
  let replyTo: Comment | null = null
  if (hasReplyTo) {
    replyTo = typeof input.replyTo === 'string' ? await findComment(page.artifact, input.replyTo) : null
    if (!replyTo) return c.json({ error: 'That comment was deleted.' }, 404)
  }
  const busy = await limitRequest(c, 'comment', user.id, 'You have written a lot of comments in a short time.')
  if (busy) return busy
  try {
    const { comment } = await addComment(page.artifact, user, checked.body, { replyTo, anchor: anchored.anchor })
    return c.json(single(comment, user, page.moderator), 201)
  } catch (err) {
    if (err instanceof CommentError) return c.json({ error: err.message }, 404)
    throw err
  }
})

// Marks every comment as read for this person, for the count of new ones
comments.post('/seen', async (c) => {
  const page = await load(c)
  if (!page) return c.json({ error: 'Not found' }, 404)
  await markSeen(c.get('user')!.id, page.artifact)
  return c.body(null, 204)
})

// { body } edits your own comment; { resolved } resolves or reopens the thread it starts
comments.patch('/:id', async (c) => {
  const page = await load(c)
  const comment = page ? await findComment(page.artifact, c.req.param('id')) : null
  if (!page || !comment) return c.json({ error: 'Not found' }, 404)
  const user = c.get('user')!
  const input = (await c.req.json().catch(() => ({}))) as { body?: unknown; resolved?: unknown }

  if (input.body !== undefined) {
    if (!canEditComment(comment, user)) return c.json({ error: 'You can only edit your own comments.' }, 403)
    const checked = checkBody(input.body)
    if ('error' in checked) return c.json({ error: checked.error, field: 'body' }, 400)
    return c.json(single(await editComment(comment, checked.body), user, page.moderator))
  }
  if (typeof input.resolved === 'boolean') {
    const thread = await threadOf(page.artifact, comment)
    if (!thread) return c.json({ error: 'Not found' }, 404)
    if (!canResolve(thread, user, page.moderator))
      return c.json({ error: 'Only the person who started this thread, or an editor of the page, can resolve it.' }, 403)
    const updated = await setResolved(thread, user.id, input.resolved)
    return c.json({ id: updated.id, resolved: updated.resolvedAt ? { at: updated.resolvedAt, by: user.name ?? user.email } : null })
  }
  return c.json({ error: 'Send a body or resolved.' }, 400)
})

// Your own comments, or any comment on a page you can edit. The first comment of a thread takes its replies with it.
comments.delete('/:id', async (c) => {
  const page = await load(c)
  const comment = page ? await findComment(page.artifact, c.req.param('id')) : null
  if (!page || !comment) return c.json({ error: 'Not found' }, 404)
  if (!canDeleteComment(comment, c.get('user')!, page.moderator)) return c.json({ error: 'You can only delete your own comments.' }, 403)
  await deleteComment(comment)
  return c.body(null, 204)
})
