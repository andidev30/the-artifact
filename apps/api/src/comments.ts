import { and, asc, count, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accessLevel, artifactUrl, canView, type LinkPass, type Viewer } from './artifacts.js'
import { db, schema } from './db/index.js'
import type { Artifact, Comment } from './db/schema.js'
import { mailEnabled } from './env.js'
import { hit } from './limits.js'
import { log } from './log.js'
import { sendCommentNotice } from './mail.js'
import { UUID_RE } from './validation.js'

export const MAX_COMMENT_LENGTH = 5000
export const THREADS_PER_PAGE = 50
export const MAX_THREADS_PER_PAGE = 100

export class CommentError extends Error {}

// Who writes: their name is shown next to the comment, their email when they have no name
export type Author = Viewer & { name: string | null }

const c = schema.artifactComments
const author = alias(schema.users, 'comment_author')
const resolver = alias(schema.users, 'comment_resolver')

// Returns the trimmed text or an error for people. Bodies are plain text; the app shows them as text.
export function checkBody(value: unknown): { body: string } | { error: string } {
  // Postgres text can't hold NUL
  const body = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replaceAll('\0', '').trim() : ''
  if (!body) return { error: 'Write something first.' }
  if (body.length > MAX_COMMENT_LENGTH) return { error: `Keep a comment under ${MAX_COMMENT_LENGTH.toLocaleString('en')} characters.` }
  return { body }
}

// Comments need a signed-in person who can open the page; editors of the page also moderate them.
// null means the same as a missing page.
export async function commentAccess(artifact: Artifact, viewer: Viewer, link: LinkPass = {}): Promise<{ moderator: boolean } | null> {
  const level = await accessLevel(artifact, viewer, link)
  return level ? { moderator: level === 'edit' } : null
}

export const canEditComment = (comment: Comment, viewer: Viewer) => comment.authorId === viewer.id
export const canDeleteComment = (comment: Comment, viewer: Viewer, moderator: boolean) => moderator || comment.authorId === viewer.id
export const canResolve = (thread: Comment, viewer: Viewer, moderator: boolean) => moderator || thread.authorId === viewer.id

export async function findComment(artifact: Artifact, id: string): Promise<Comment | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db
    .select()
    .from(c)
    .where(and(eq(c.id, id), eq(c.artifactId, artifact.id)))
  return row ?? null
}

// The first comment of the thread this one is in (itself, when it starts one)
export async function threadOf(artifact: Artifact, comment: Comment): Promise<Comment | null> {
  return comment.parentId ? findComment(artifact, comment.parentId) : comment
}

const isForeignKeyViolation = (err: unknown) => (err as { code?: string }).code === '23503' || (err as { cause?: { code?: string } }).cause?.code === '23503'

// A reply to a reply joins the same thread, so threads stay one level deep. Replying reopens a resolved thread.
export async function addComment(artifact: Artifact, by: Author, body: string, opts: { replyTo?: Comment | null; postedWith?: string | null } = {}) {
  const thread = opts.replyTo ? await threadOf(artifact, opts.replyTo) : null
  if (opts.replyTo && !thread) throw new CommentError('That comment was deleted.')
  let row: Comment
  try {
    ;[row] = await db
      .insert(c)
      .values({
        artifactId: artifact.id,
        parentId: thread?.id ?? null,
        authorId: by.id,
        body,
        version: artifact.currentVersion,
        postedWith: opts.postedWith ?? null,
      })
      .returning()
  } catch (err) {
    // The thread was deleted between reading it and replying
    if (isForeignKeyViolation(err)) throw new CommentError('That comment was deleted.')
    throw err
  }
  if (thread?.resolvedAt) await db.update(c).set({ resolvedAt: null, resolvedBy: null }).where(eq(c.id, thread.id))
  await notify(artifact, by, row, thread)
  return { comment: row, thread }
}

export async function editComment(comment: Comment, body: string): Promise<Comment> {
  const [row] = await db.update(c).set({ body, editedAt: new Date() }).where(eq(c.id, comment.id)).returning()
  return row
}

// Deleting the first comment of a thread deletes its replies too (the foreign key cascades)
export async function deleteComment(comment: Comment) {
  await db.delete(c).where(eq(c.id, comment.id))
}

export async function setResolved(thread: Comment, userId: string, resolved: boolean): Promise<Comment> {
  const [row] = await db
    .update(c)
    .set(resolved ? { resolvedAt: new Date(), resolvedBy: userId } : { resolvedAt: null, resolvedBy: null })
    .where(eq(c.id, thread.id))
    .returning()
  return row
}

// The page's owner hears about every comment, and a thread's author about replies to it, but nobody
// about their own. At most one email per page and person in the "comment-email" window, so a burst
// of comments is one email; the rest show as new in the app.
async function notify(artifact: Artifact, by: Author, comment: Comment, thread: Comment | null) {
  if (!mailEnabled()) return
  const ids = new Set([artifact.ownerId])
  if (thread?.authorId) ids.add(thread.authorId)
  ids.delete(by.id)
  if (ids.size === 0) return
  const people = await db
    .select({ id: schema.users.id, email: schema.users.email, suspendedAt: schema.users.suspendedAt })
    .from(schema.users)
    .where(inArray(schema.users.id, [...ids]))
  const from = by.name ?? by.email
  const link = `${artifactUrl(artifact.slug)}?comments`
  await Promise.all(
    people.map(async (p) => {
      if (p.suspendedAt) return
      // Someone who started a thread may have lost access to the page since
      if (p.id !== artifact.ownerId && !(await canView(artifact, p))) return
      if ((await hit('comment-email', `${artifact.id}:${p.id}`)) !== null) return
      try {
        await sendCommentNotice(p.email, {
          from,
          title: artifact.title,
          link,
          body: comment.body,
          reply: thread !== null && p.id === thread.authorId,
          version: comment.version,
        })
      } catch (err) {
        log.error('Comment notice failed', { err, artifactId: artifact.id })
      }
    }),
  )
}

// Threads oldest first, paged by the (created_at, id) of their first comment, like the gallery's
// cursor (with every microsecond, which a Date would round away)
const CURSOR_AT = sql<string>`to_char(${c.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export class CommentCursorError extends Error {
  constructor() {
    super('That cursor is not from this list. Start again from the first comments.')
  }
}

function after(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined
  const [at = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (!CURSOR_RE.test(at) || !UUID_RE.test(id)) throw new CommentCursorError()
  return sql`(${c.createdAt}, ${c.id}) > (${at}::timestamptz, ${id}::uuid)`
}

const FIELDS = {
  comment: c,
  authorName: author.name,
  authorEmail: author.email,
  resolvedByName: resolver.name,
  resolvedByEmail: resolver.email,
  cursorAt: CURSOR_AT,
}

type Row = { comment: Comment; authorName: string | null; authorEmail: string | null; resolvedByName: string | null; resolvedByEmail: string | null }

export type ListedComment = Comment & { authorLabel: string | null; resolvedByLabel: string | null }
export type Thread = ListedComment & { replies: ListedComment[] }

const listed = (r: Row): ListedComment => ({
  ...r.comment,
  authorLabel: r.authorName ?? r.authorEmail,
  resolvedByLabel: r.resolvedByName ?? r.resolvedByEmail,
})

export type ThreadOptions = { includeResolved?: boolean; cursor?: string; limit?: number }

export async function listThreads(artifact: Artifact, opts: ThreadOptions = {}): Promise<{ threads: Thread[]; next: string | null }> {
  const limit =
    opts.limit === undefined || !Number.isFinite(opts.limit) ? THREADS_PER_PAGE : Math.min(MAX_THREADS_PER_PAGE, Math.max(1, Math.floor(opts.limit)))
  const rows = await db
    .select(FIELDS)
    .from(c)
    .leftJoin(author, eq(c.authorId, author.id))
    .leftJoin(resolver, eq(c.resolvedBy, resolver.id))
    .where(and(eq(c.artifactId, artifact.id), isNull(c.parentId), opts.includeResolved ? undefined : isNull(c.resolvedAt), after(opts.cursor)))
    .orderBy(asc(c.createdAt), asc(c.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const next = rows.length > limit && last ? Buffer.from(`${last.cursorAt}|${last.comment.id}`).toString('base64url') : null

  const replies = page.length
    ? await db
        .select(FIELDS)
        .from(c)
        .leftJoin(author, eq(c.authorId, author.id))
        .leftJoin(resolver, eq(c.resolvedBy, resolver.id))
        .where(
          inArray(
            c.parentId,
            page.map((r) => r.comment.id),
          ),
        )
        .orderBy(asc(c.createdAt), asc(c.id))
    : []
  const byThread = new Map<string, ListedComment[]>()
  for (const r of replies) {
    const list = byThread.get(r.comment.parentId!) ?? []
    list.push(listed(r))
    byThread.set(r.comment.parentId!, list)
  }
  return { threads: page.map((r) => ({ ...listed(r), replies: byThread.get(r.comment.id) ?? [] })), next }
}

export async function countThreads(artifact: Artifact): Promise<{ open: number; resolved: number }> {
  const rows = await db
    .select({ resolved: isNotNull(c.resolvedAt), n: count() })
    .from(c)
    .where(and(eq(c.artifactId, artifact.id), isNull(c.parentId)))
    .groupBy(isNotNull(c.resolvedAt))
  return { open: rows.find((r) => !r.resolved)?.n ?? 0, resolved: rows.find((r) => r.resolved)?.n ?? 0 }
}

export type CommentCount = { total: number; unread: number }

// For each page, its comments and how many of them other people wrote since this person last opened
// the page's comments (all of them, when they never did)
export async function commentCounts(userId: string, artifactIds: string[]): Promise<Map<string, CommentCount>> {
  if (artifactIds.length === 0) return new Map()
  const r = schema.commentReads
  const rows = await db
    .select({
      artifactId: c.artifactId,
      total: sql<number>`count(*)::int`,
      unread: sql<number>`(count(*) filter (where ${c.authorId} is distinct from ${userId}::uuid and (${r.seenAt} is null or ${c.createdAt} > ${r.seenAt})))::int`,
    })
    .from(c)
    .leftJoin(r, and(eq(r.artifactId, c.artifactId), eq(r.userId, userId)))
    .where(inArray(c.artifactId, artifactIds))
    .groupBy(c.artifactId)
  return new Map(rows.map((row) => [row.artifactId, { total: row.total, unread: row.unread }]))
}

export async function lastSeen(userId: string, artifact: Artifact): Promise<Date | null> {
  const r = schema.commentReads
  const [row] = await db
    .select({ seenAt: r.seenAt })
    .from(r)
    .where(and(eq(r.userId, userId), eq(r.artifactId, artifact.id)))
  return row?.seenAt ?? null
}

export async function markSeen(userId: string, artifact: Artifact) {
  await db
    .insert(schema.commentReads)
    .values({ userId, artifactId: artifact.id, seenAt: sql`now()` })
    .onConflictDoUpdate({ target: [schema.commentReads.userId, schema.commentReads.artifactId], set: { seenAt: sql`now()` } })
}
