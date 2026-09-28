import { lte } from 'drizzle-orm'
import { db, schema } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { VERSION } from './version.js'

// Tells the admins of a self-hosted install when a newer release exists. The server asks GitHub's
// public releases API at most once a day, only when an admin opens the admin area, and sends
// nothing about the install: no custom headers, no query parameters that identify it.

export const RELEASES_API = 'https://api.github.com/repos/andidev30/the-artifact/releases?per_page=30'
const RELEASE_PAGE = 'https://github.com/andidev30/the-artifact/releases/'
const DAY_MS = 24 * 60 * 60 * 1000

type SemVer = { major: number; minor: number; patch: number; pre: string[] }

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): SemVer | null {
  const m = SEMVER_RE.exec(value.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

// Semantic Versioning 2.0 precedence: negative when a comes first, 0 when equal, positive when a is newer
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  // A pre-release comes before the release it leads up to
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) - Number(y)
    if (xNum !== yNum) return xNum ? -1 : 1
    return x < y ? -1 : 1
  }
  return a.pre.length - b.pre.length
}

type GitHubRelease = { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }

// The newest server release in a GitHub releases list. Skips drafts, pre-releases and the CLI's own
// releases (tagged cli-vX.Y.Z), which share the repository.
export function newestRelease(releases: unknown): { version: string; url: string } | null {
  if (!Array.isArray(releases)) return null
  let best: { version: string; url: string; parsed: SemVer } | null = null
  for (const r of releases as GitHubRelease[]) {
    if (!r || r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') continue
    if (!r.tag_name.startsWith('v')) continue
    const parsed = parseVersion(r.tag_name)
    if (!parsed || parsed.pre.length) continue
    // Only ever link to this repository's release pages, whatever the response says
    const url = typeof r.html_url === 'string' && r.html_url.startsWith(RELEASE_PAGE) ? r.html_url : `${RELEASE_PAGE}tag/${encodeURIComponent(r.tag_name)}`
    if (!best || compareVersions(parsed, best.parsed) > 0) best = { version: r.tag_name.slice(1), url, parsed }
  }
  return best && { version: best.version, url: best.url }
}

export type ReleaseStatus = {
  current: string
  // Set only when a newer release than this server's exists
  newer: { version: string; url: string } | null
}

async function fetchNewest() {
  const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return newestRelease(await res.json())
}

// What the admin area shows. Does nothing on the hosted service or with RELEASE_CHECK=false; never
// throws, so a failed check can't break the admin page.
export async function releaseStatus(now = new Date()): Promise<ReleaseStatus> {
  const none = { current: VERSION, newer: null }
  if (!env.selfHosted || !env.releaseCheck) return none
  try {
    // Claiming the check before asking GitHub keeps several processes, or several admins at once,
    // to one request a day between them. A failed request also waits a day.
    const claimed = await db
      .insert(schema.releaseCheck)
      .values({ id: 1, checkedAt: now })
      .onConflictDoUpdate({
        target: schema.releaseCheck.id,
        set: { checkedAt: now },
        setWhere: lte(schema.releaseCheck.checkedAt, new Date(now.getTime() - DAY_MS)),
      })
      .returning({ id: schema.releaseCheck.id })
    if (claimed.length) {
      try {
        const newest = await fetchNewest()
        if (newest) await db.update(schema.releaseCheck).set({ latestVersion: newest.version, releaseUrl: newest.url })
      } catch (err) {
        log.warn('release check failed', { err })
      }
    }
    const [row] = await db.select().from(schema.releaseCheck)
    const latest = row?.latestVersion ? parseVersion(row.latestVersion) : null
    const current = parseVersion(VERSION)
    if (!latest || !current || !row.releaseUrl || compareVersions(latest, current) <= 0) return none
    return { current: VERSION, newer: { version: row.latestVersion!, url: row.releaseUrl } }
  } catch (err) {
    log.warn('release check failed', { err })
    return none
  }
}
