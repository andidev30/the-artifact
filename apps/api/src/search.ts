import { and, eq, like, sql, type SQL } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { log, requestContext } from './log.js'
import { extractText } from './prepare.js'
import { getBlob, getText } from './storage.js'

// Search matches a page's title (ILIKE, see likeTerm in artifacts.ts) or the words of its current
// version. The words are kept as a stripped tsvector with the 'simple' configuration: no stemming and
// no stop words, so it behaves the same for every language, and a GIN index finds a word among
// thousands of long pages without reading their text. pg_trgm was the other choice, but on text this
// long nearly every page has every common trigram, so its index narrows little and each candidate's
// 200 KB has to be read again; tsvector needs no extension either.
//
// When a version becomes current its text is indexed: in the publish transaction when it is short,
// and otherwise just after, on the long-running server in the background (indexInBackground) and on
// serverless hosts before the response, since nothing runs after it there. A page whose row is
// missing or built from an older version is found by staleIds and indexed again by the scheduled
// sweep, /api/cron/sweep and the search:backfill script.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const s = schema.artifactSearch

// Text up to this long is indexed inside the publish transaction; to_tsvector takes about a
// millisecond per 10,000 characters, and longer text shouldn't hold the page's lock for it
export const INLINE_TEXT_CHARS = 20_000

// The query's words as Postgres splits the page's text into words, each matching words that start
// with it, all of them needed: "quarterly rev" finds "Quarterly revenue". Built from the lexemes by
// the tsquery cast, which takes them literally; to_tsquery would split them again into phrases, which
// a stripped tsvector can't match. In that syntax a quote is doubled and a backslash escaped.
const QUERY = (q: string) => sql`(
  select string_agg('''' || replace(replace(lexeme, '\\', '\\\\'), '''', '''''') || ''':*', ' & ')::tsquery
  from unnest(to_tsvector('simple', ${q})))`

// Pages whose current version has these words, for the listing's where clause; undefined when the
// query has no word to look for
export function contentMatches(artifactId: SQL | typeof schema.artifacts.id, q: string): SQL | undefined {
  const query = q.replaceAll('\0', '')
  if (!/[\p{L}\p{N}]/u.test(query)) return undefined
  return sql`${artifactId} in (select ${s.artifactId} from ${s} where ${s.words} @@ ${QUERY(query)})`
}

// The caller holds the page row locked and knows versionId is its current version
export async function writeWords(q: Tx, artifactId: string, versionId: string, text: string) {
  const words = sql`strip(to_tsvector('simple', ${text}))`
  await q
    .insert(s)
    .values({ artifactId, versionId, words })
    .onConflictDoUpdate({ target: s.artifactId, set: { versionId, words, indexedAt: sql`now()` } })
}

// The text of a stored version: its entry and its other HTML files
async function storedText(version: { id: string; htmlSha256: string }): Promise<string> {
  const f = schema.artifactFiles
  const [entry, rows] = await Promise.all([
    getText(version.htmlSha256),
    db
      .select({ path: f.path, sha256: f.sha256 })
      .from(f)
      .where(and(eq(f.versionId, version.id), like(f.contentType, 'text/html%'))),
  ])
  if (entry === null) log.warn('The HTML of a version is missing from storage; indexing it without', { versionId: version.id })
  const others = await Promise.all(rows.map(async (r) => ({ path: r.path, html: (await getBlob(r.sha256))?.toString('utf8') ?? '' })))
  return extractText(entry ?? '', others)
}

// Text of a version already at hand, or on its way from a worker thread; null means read it back
type Known = { versionId: string; text: string | Promise<string | null> }

// Indexes the page's current version, using the text given when it is of that version. Nothing
// happens when the page is gone; a version that stopped being current meanwhile is left to whoever
// made the next one current.
export async function indexPage(artifactId: string, known?: Known): Promise<'indexed' | 'missing' | 'moved'> {
  const a = schema.artifacts
  const v = schema.artifactVersions
  const [current] = await db
    .select({ id: v.id, htmlSha256: v.htmlSha256 })
    .from(a)
    .innerJoin(v, and(eq(v.artifactId, a.id), eq(v.version, a.currentVersion)))
    .where(eq(a.id, artifactId))
  if (!current) return 'missing'
  const text = (known?.versionId === current.id ? await known.text : null) ?? (await storedText(current))
  return db.transaction(async (tx) => {
    // Shares the lock publish and restore take for update, so a newer version can't become current
    // between this check and the write
    const [still] = await tx
      .select({ id: v.id })
      .from(a)
      .innerJoin(v, and(eq(v.artifactId, a.id), eq(v.version, a.currentVersion)))
      .where(eq(a.id, artifactId))
      .for('share', { of: a })
    if (!still) return 'missing'
    if (still.id !== current.id) return 'moved'
    await writeWords(tx, artifactId, current.id, text)
    return 'indexed'
  })
}

// Pages with no words yet or words of an older version, most recently updated first
export async function staleIds(limit?: number): Promise<string[]> {
  const a = schema.artifacts
  const v = schema.artifactVersions
  const query = db
    .select({ id: a.id })
    .from(a)
    .innerJoin(v, and(eq(v.artifactId, a.id), eq(v.version, a.currentVersion)))
    .leftJoin(s, eq(s.artifactId, a.id))
    .where(sql`${s.versionId} is distinct from ${v.id}`)
    .orderBy(sql`${a.updatedAt} desc`)
  const rows = limit ? await query.limit(limit) : await query
  return rows.map((r) => r.id)
}

// For the scheduled sweep: a few hundred at a time keeps each run short, and none started once
// `deadline` (epoch ms) has passed; the backfill script does all
export async function indexStale(limit = 500, deadline = Number.POSITIVE_INFINITY): Promise<number> {
  let indexed = 0
  if (Date.now() >= deadline) return indexed
  for (const id of await staleIds(limit)) {
    if (Date.now() >= deadline) break
    const result = await indexPage(id).catch((err) => log.error('Indexing a page for search failed', { artifactId: id, err }))
    if (result === 'indexed') indexed += 1
  }
  return indexed
}

let background = false
const pending = new Map<string, Known | undefined>()
let running: Promise<void> | null = null
const MAX_QUEUE = 10_000

// The long-running server indexes after answering; elsewhere indexLater waits for it
export function indexInBackground(on = true) {
  background = on
}

// After a version became current. Never throws: search catches up on the next sweep if this fails.
export async function indexLater(artifactId: string, known?: Known): Promise<void> {
  if (!background) {
    await indexPage(artifactId, known).catch((err) => log.error('Indexing a page for search failed', { artifactId, err }))
    return
  }
  // The latest publish of a page replaces one still waiting; a full queue is left to the sweep
  if (!pending.has(artifactId) && pending.size >= MAX_QUEUE) return
  pending.set(artifactId, known)
  kick()
}

function kick() {
  if (running || !pending.size) return
  // Outside the request's context: the queue outlives it and indexes other people's pages too
  running = requestContext.exit(work).finally(() => {
    running = null
    kick()
  })
}

async function work() {
  // Let the publish that queued this finish its response first
  await new Promise((r) => setImmediate(r))
  for (const [id, known] of pending) {
    pending.delete(id)
    await indexPage(id, known).catch((err) => log.error('Indexing a page for search failed', { artifactId: id, err }))
  }
}

// Resolves once the background queue is empty (tests)
export async function searchQueueIdle() {
  while (running) await running
}
