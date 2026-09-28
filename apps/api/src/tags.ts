import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { pagesInWorkspace, readableIn, type Viewer } from './artifacts.js'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import type { Workspace } from './quota.js'
import { hasControlChars } from './validation.js'

// Tags are short labels on a page. Editors change them; everyone who can open the page sees them.
// They belong to the page's workspace: its gallery lists the tags of the pages you see there.

export const MAX_TAG_LENGTH = 32
export const MAX_TAGS = 10

export class TagError extends Error {}

const t = schema.artifactTags

// Lowercase, trimmed, with runs of spaces made one. Commas separate tags where people type several.
export function checkTag(value: unknown): { tag: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'A tag is a short text, like "q3" or "design review".' }
  const tag = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!tag) return { error: 'A tag needs at least one character.' }
  if (hasControlChars(tag)) return { error: "A tag can't contain control characters." }
  if (tag.includes(',')) return { error: "A tag can't contain a comma. Add each tag on its own." }
  if ([...tag].length > MAX_TAG_LENGTH) return { error: `Keep each tag to ${MAX_TAG_LENGTH} characters; "${tag.slice(0, 40)}…" is longer.` }
  return { tag }
}

function checkAll(values: unknown): string[] {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values)) throw new TagError('Send tags as a list, like ["q3", "draft"].')
  if (values.length > 50) throw new TagError('Send fewer tags at once.')
  const tags = new Set<string>()
  for (const v of values) {
    const checked = checkTag(v)
    if ('error' in checked) throw new TagError(checked.error)
    tags.add(checked.tag)
  }
  return [...tags]
}

// A page's tags, by page id, each list in order
export async function tagsOf(artifactIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (!artifactIds.length) return map
  const rows = await db.select({ artifactId: t.artifactId, tag: t.tag }).from(t).where(inArray(t.artifactId, artifactIds)).orderBy(asc(t.tag))
  for (const r of rows) map.set(r.artifactId, [...(map.get(r.artifactId) ?? []), r.tag])
  return map
}

// Adds and removes tags, removing first, and returns the page's tags. Throws TagError for a tag that
// breaks the rules or a page that would have more than MAX_TAGS. Doesn't touch updated_at, like filing.
export async function changeTags(artifact: Artifact, change: { add?: unknown; remove?: unknown }): Promise<string[]> {
  const add = checkAll(change.add)
  const remove = checkAll(change.remove)
  return db.transaction(async (tx) => {
    // Two changes at once can't take a page past the limit
    await tx.select({ id: schema.artifacts.id }).from(schema.artifacts).where(eq(schema.artifacts.id, artifact.id)).for('update')
    if (remove.length) await tx.delete(t).where(and(eq(t.artifactId, artifact.id), inArray(t.tag, remove)))
    const current = (await tx.select({ tag: t.tag }).from(t).where(eq(t.artifactId, artifact.id))).map((r) => r.tag)
    const added = add.filter((tag) => !current.includes(tag))
    if (current.length + added.length > MAX_TAGS) {
      throw new TagError(`A page can have up to ${MAX_TAGS} tags. Remove one before adding another.`)
    }
    if (added.length) await tx.insert(t).values(added.map((tag) => ({ artifactId: artifact.id, tag })))
    return [...current, ...added].sort()
  })
}

// The tags of the pages this person sees in the workspace and can open, with how many pages have each
export async function workspaceTags(ws: Workspace, viewer: Viewer) {
  const a = schema.artifacts
  return db
    .select({ tag: t.tag, pages: count() })
    .from(t)
    .innerJoin(a, eq(a.id, t.artifactId))
    .where(and(pagesInWorkspace(viewer.id, ws.organizationId), readableIn(viewer, ws.organizationId)))
    .groupBy(t.tag)
    .orderBy(asc(t.tag))
}

// For list filters: a tag as people typed it, or null when no page could have it
export function normalTag(value: string): string | null {
  const checked = checkTag(value)
  return 'tag' in checked ? checked.tag : null
}
