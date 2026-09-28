import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, asc, count, desc, eq, gt, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { accessLevel, artifactUrl, loadVersionTree, VISIBILITY_LABEL, type Viewer } from './artifacts.js'
import { blockedOrganizations } from './auth/factors.js'
import { db, schema } from './db/index.js'
import type { Artifact, DataExport } from './db/schema.js'
import { env, mailEnabled } from './env.js'
import { ENTRY_PATH } from './files.js'
import { refund } from './limits.js'
import { log } from './log.js'
import { sendExportReady } from './mail.js'
import { serverSecret } from './secrets.js'
import {
  abortMultipart,
  completeMultipart,
  deleteObjects,
  EXPORTS,
  getObject,
  listMultipartUploads,
  listObjects,
  putObject,
  startMultipart,
  uploadPart,
} from './storage.js'
import { ZipWriter, zipEnd } from './zip.js'

// Exports of someone's data: every page they own (or, for an organization's owner, every page in it)
// with its versions, sharing and comments, and their account or the organization as JSON, in one zip.
//
// An export can be far bigger than memory and take longer than a serverless function may run (60 s
// on the hosted service), so it is built in steps of at most STEP_MS. Each step claims the row with a
// lease, appends files to the zip and uploads it to the bucket as the parts of a multipart upload, and
// saves where it got to: the page it is on, the parts so far, the zip's central directory, and the few
// bytes too small to be a part yet, which wait in the bucket. The last step writes the directory and
// completes the upload. Only one version of one page is in memory at a time.
//
// Who drives the steps: the long-running server builds an export in the process that was asked for it,
// and its background process picks up any that were left behind (a restart). Without a long-running
// process (Vercel), the settings page asks for the export's status every few seconds while it is being
// built, and each of those requests runs a step; /api/cron/sweep runs a few steps of any left behind.

export const EXPORT_HOURS = 24
// S3 needs every part but the last to be at least 5 MB
const PART_BYTES = 8 * 1024 * 1024
const STEP_MS = 20_000
// Longer than any step, so a step never runs with an expired lease; a crashed one is resumed after it
const LEASE_SECONDS = 120
const MAX_FAILURES = 3
// Builds nobody drove for this long are given up
const ABANDONED_MS = 7 * 24 * 3600_000
const HOUR = 3600_000

type Stage = 'start' | 'pages' | 'comments' | 'finish'

type Progress = {
  stage: Stage
  // The last page written in full; pages go in id order
  after: string | null
  // The page being written, and its versions still to write
  page: { id: string; slug: string } | null
  versions: number[]
  pagesDone: number
  pagesTotal: number
  uploadId: string | null
  parts: { n: number; etag: string }[]
  // Bytes of the zip so far, uploaded or carried
  offset: number
  entries: number
  // The object holding bytes written but not uploaded yet
  carry: string | null
  failures: number
  exportedAt: string
}

const t = schema.dataExports
const a = schema.artifacts

export const zipKey = (id: string) => `${EXPORTS}${id}/export.zip`
const prefixOf = (id: string) => `${EXPORTS}${id}/`

// Rate limit keys: one export of an account, and one of an organization, per window
export const limitKey = (e: Pick<DataExport, 'userId' | 'organizationId'>) => (e.organizationId ? `org:${e.organizationId}` : `user:${e.userId}`)

function pagesOf(e: Pick<DataExport, 'userId' | 'organizationId'>): SQL {
  return e.organizationId ? eq(a.organizationId, e.organizationId) : eq(a.ownerId, e.userId)
}

export async function createExport(userId: string, organizationId: string | null, allVersions: boolean): Promise<DataExport> {
  const [{ n }] = await db.select({ n: count() }).from(a).where(pagesOf({ userId, organizationId }))
  const progress: Progress = {
    stage: 'start',
    after: null,
    page: null,
    versions: [],
    pagesDone: 0,
    pagesTotal: n,
    uploadId: null,
    parts: [],
    offset: 0,
    entries: 0,
    carry: null,
    failures: 0,
    exportedAt: new Date().toISOString(),
  }
  const [row] = await db.insert(t).values({ userId, organizationId, allVersions, progress }).returning()
  return row
}

// The newest export of the account (organizationId null) or organization this person asked for, while
// it is being built or can be downloaded, or failed recently
export async function latestExport(userId: string, organizationId: string | null, now = new Date()): Promise<DataExport | null> {
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.userId, userId), organizationId ? eq(t.organizationId, organizationId) : isNull(t.organizationId)))
    .orderBy(desc(t.createdAt))
    .limit(1)
  if (!row) return null
  if (row.status === 'ready' && (!row.expiresAt || row.expiresAt <= now)) return null
  if (row.status === 'failed' && now.getTime() - row.createdAt.getTime() > EXPORT_HOURS * HOUR) return null
  return row
}

export async function findExport(id: string): Promise<DataExport | null> {
  const [row] = await db.select().from(t).where(eq(t.id, id))
  return row ?? null
}

// The download link names the export and the person, signed with a server key. The session must be
// that person's too, and the export unexpired, when it is used.
async function signature(id: string, userId: string) {
  return createHmac('sha256', await serverSecret('export-links'))
    .update(`${id}|${userId}`)
    .digest('base64url')
}

export async function downloadPath(e: DataExport): Promise<string> {
  return `/api/exports/${e.id}/download?sig=${await signature(e.id, e.userId)}`
}

export async function signatureMatches(e: DataExport, given: string): Promise<boolean> {
  const expected = Buffer.from(await signature(e.id, e.userId))
  const got = Buffer.from(given)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

// "the-artifact-export-2026-09-29.zip", or "acme-export-2026-09-29.zip" for an organization
export function exportFilename(e: DataExport, orgSlug: string | null): string {
  return `${orgSlug ?? 'the-artifact'}-export-${(e.finishedAt ?? e.createdAt).toISOString().slice(0, 10)}.zip`
}

export async function describeExport(e: DataExport) {
  const p = e.progress as Progress
  return {
    id: e.id,
    status: e.status,
    allVersions: e.allVersions,
    createdAt: e.createdAt,
    finishedAt: e.finishedAt,
    expiresAt: e.expiresAt,
    size: e.size,
    pagesDone: p.pagesDone,
    pagesTotal: p.pagesTotal,
    error: e.error,
    downloadUrl: e.status === 'ready' ? await downloadPath(e) : null,
    // Whether the build moves on only while someone asks how it is going, so the settings page must stay open
    buildsOnPoll: !inProcess,
  }
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

function readme(e: DataExport, who: { email: string }, org: { name: string } | null, exportedAt: string): string {
  const scope = org ? `the organization ${org.name}` : `the account ${who.email}`
  const lines = [
    'Your data from The Artifact',
    '===========================',
    '',
    `An export of ${scope} from ${env.appUrl}, made on ${exportedAt} (UTC).`,
    '',
    'What is in it',
    '-------------',
    '',
    org
      ? 'organization.json      The organization: its name and settings, its members (name, email, role), pending invitations and folders.'
      : 'account.json           Your account: profile, how you sign in, your organizations, connected agents, access tokens and sessions.',
    org
      ? `pages/<page>/          One folder for every page in ${org.name}, named after the page's address (${env.appUrl}/a/<page>).`
      : `pages/<page>/          One folder for every page you own, in your personal workspace and in organizations, named after the page's address (${env.appUrl}/a/<page>).`,
    '  page.json            The page: title, owner, workspace, folder, who can open it, the people it is shared with, and its versions with',
    '                       when and by whom each was published.',
    '  comments.json        The comments on the page, with the display name of each author (null when they have none or deleted their account).',
    '  versions/<n>/        The files of version n: index.html and the files next to it. Open index.html in a browser to see the page.',
    ...(org ? [] : ["comments.json          Comments you wrote on other people's pages. The page is named only while you can still open it."]),
    '',
    e.allVersions ? 'Every version of every page is included.' : 'Only the current version of each page is included; page.json still lists every version.',
    'A version deleted while the export was being built may be missing.',
    '',
    'Secrets are never exported: no passwords, no access token or agent token values, no keys of shared links and no',
    'password hashes. Times are in UTC (ISO 8601).',
    '',
  ]
  return lines.join('\n')
}

async function accountJson(userId: string, exportedAt: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  const passkeys = await db
    .select({ name: schema.passkeys.name, backedUp: schema.passkeys.backedUp, createdAt: schema.passkeys.createdAt, lastUsedAt: schema.passkeys.lastUsedAt })
    .from(schema.passkeys)
    .where(eq(schema.passkeys.userId, userId))
    .orderBy(asc(schema.passkeys.createdAt))
  const [totp] = await db.select({ confirmedAt: schema.totpSecrets.confirmedAt }).from(schema.totpSecrets).where(eq(schema.totpSecrets.userId, userId))
  const [{ codes }] = await db.select({ codes: count() }).from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId))
  const sso = await db
    .select({
      connection: schema.ssoConnections.name,
      email: schema.ssoIdentities.email,
      createdAt: schema.ssoIdentities.createdAt,
      lastUsedAt: schema.ssoIdentities.lastUsedAt,
    })
    .from(schema.ssoIdentities)
    .innerJoin(schema.ssoConnections, eq(schema.ssoIdentities.connectionId, schema.ssoConnections.id))
    .where(eq(schema.ssoIdentities.userId, userId))
  const organizations = await db
    .select({ name: schema.organizations.name, slug: schema.organizations.slug, role: schema.memberships.role, joinedAt: schema.memberships.createdAt })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.createdAt))
  const folders = await db
    .select({ name: schema.folders.name, createdAt: schema.folders.createdAt })
    .from(schema.folders)
    .where(and(eq(schema.folders.ownerId, userId), isNull(schema.folders.organizationId)))
    .orderBy(asc(schema.folders.name))
  // Agents by their name, the workspace they publish to and when; never their tokens
  const agents = await db
    .select({
      name: schema.oauthClients.name,
      workspace: schema.organizations.name,
      connectedAt: sql<Date>`min(${schema.oauthTokens.createdAt})`.mapWith(schema.oauthTokens.createdAt),
      lastUsedAt: sql<Date | null>`max(${schema.oauthTokens.lastUsedAt})`.mapWith(schema.oauthTokens.lastUsedAt),
    })
    .from(schema.oauthTokens)
    .innerJoin(schema.oauthClients, eq(schema.oauthTokens.clientId, schema.oauthClients.id))
    .leftJoin(schema.organizations, eq(schema.oauthTokens.organizationId, schema.organizations.id))
    .where(and(eq(schema.oauthTokens.userId, userId), gt(schema.oauthTokens.expiresAt, new Date())))
    .groupBy(schema.oauthClients.id, schema.oauthClients.name, schema.organizations.name)
  const tokens = await db
    .select({
      name: schema.accessTokens.name,
      workspace: schema.organizations.name,
      createdAt: schema.accessTokens.createdAt,
      expiresAt: schema.accessTokens.expiresAt,
      lastUsedAt: schema.accessTokens.lastUsedAt,
    })
    .from(schema.accessTokens)
    .leftJoin(schema.organizations, eq(schema.accessTokens.organizationId, schema.organizations.id))
    .where(eq(schema.accessTokens.userId, userId))
    .orderBy(asc(schema.accessTokens.createdAt))
  const sessions = await db
    .select({
      browser: schema.sessions.userAgent,
      signedInAt: schema.sessions.createdAt,
      lastActiveAt: schema.sessions.lastActiveAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
    .orderBy(asc(schema.sessions.createdAt))

  return {
    exportedAt,
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: !user.emailUnverified,
      instanceAdmin: user.isAdmin,
      createdAt: iso(user.createdAt),
    },
    signIn: {
      password: user.passwordHash !== null,
      google: user.googleSub !== null,
      passkeys: passkeys.map((p) => ({ name: p.name, syncedToCloudAccount: p.backedUp, addedAt: iso(p.createdAt), lastUsedAt: iso(p.lastUsedAt) })),
      authenticatorApp: totp?.confirmedAt ? { addedAt: iso(totp.confirmedAt) } : null,
      recoveryCodesLeft: codes,
      singleSignOn: sso.map((s) => ({ connection: s.connection, email: s.email, firstUsedAt: iso(s.createdAt), lastUsedAt: iso(s.lastUsedAt) })),
    },
    organizations: organizations.map((o) => ({ name: o.name, slug: o.slug, role: o.role, joinedAt: iso(o.joinedAt) })),
    folders: folders.map((f) => ({ name: f.name, createdAt: iso(f.createdAt) })),
    connectedAgents: agents.map((g) => ({
      name: g.name,
      workspace: g.workspace ?? 'Personal',
      connectedAt: iso(g.connectedAt),
      lastUsedAt: iso(g.lastUsedAt),
    })),
    accessTokens: tokens.map((k) => ({
      name: k.name,
      workspace: k.workspace ?? 'Personal',
      createdAt: iso(k.createdAt),
      expiresAt: iso(k.expiresAt),
      lastUsedAt: iso(k.lastUsedAt),
    })),
    sessions: sessions.map((s) => ({ browser: s.browser, signedInAt: iso(s.signedInAt), lastActiveAt: iso(s.lastActiveAt), expiresAt: iso(s.expiresAt) })),
  }
}

async function organizationJson(organizationId: string, exportedAt: string) {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, organizationId))
  const members = await db
    .select({ name: schema.users.name, email: schema.users.email, role: schema.memberships.role, joinedAt: schema.memberships.createdAt })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(asc(schema.memberships.createdAt))
  const invitations = await db
    .select({
      email: schema.invitations.email,
      role: schema.invitations.role,
      createdAt: schema.invitations.createdAt,
      expiresAt: schema.invitations.expiresAt,
    })
    .from(schema.invitations)
    .where(eq(schema.invitations.organizationId, organizationId))
    .orderBy(asc(schema.invitations.createdAt))
  const folders = await db
    .select({ name: schema.folders.name, createdAt: schema.folders.createdAt })
    .from(schema.folders)
    .where(eq(schema.folders.organizationId, organizationId))
    .orderBy(asc(schema.folders.name))
  const [retention] = await db.select().from(schema.retentionPolicies).where(eq(schema.retentionPolicies.organizationId, organizationId))
  return {
    exportedAt,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: iso(org.createdAt),
      requireTwoFactor: org.requireTwoFactor,
      versionRetention: retention ? { keepDays: retention.keepDays, keepVersions: retention.keepVersions } : null,
    },
    members: members.map((m) => ({ name: m.name, email: m.email, role: m.role, joinedAt: iso(m.joinedAt) })),
    invitations: invitations.map((i) => ({ email: i.email, role: i.role, invitedAt: iso(i.createdAt), expiresAt: iso(i.expiresAt) })),
    folders: folders.map((f) => ({ name: f.name, createdAt: iso(f.createdAt) })),
  }
}

async function pageJson(page: Artifact, e: DataExport) {
  const [owner] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, page.ownerId))
  const [org] = page.organizationId
    ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, page.organizationId))
    : []
  const [folder] = page.folderId ? await db.select({ name: schema.folders.name }).from(schema.folders).where(eq(schema.folders.id, page.folderId)) : []
  const shares = await db
    .select({ email: schema.artifactShares.email, role: schema.artifactShares.role, createdAt: schema.artifactShares.createdAt })
    .from(schema.artifactShares)
    .where(eq(schema.artifactShares.artifactId, page.id))
    .orderBy(asc(schema.artifactShares.createdAt))
  const v = schema.artifactVersions
  const versions = await db
    .select({
      version: v.version,
      createdAt: v.createdAt,
      publishedWith: v.publishedWith,
      restoredFrom: v.restoredFrom,
      byName: schema.users.name,
      byEmail: schema.users.email,
      views: schema.artifactViewCounts.views,
    })
    .from(v)
    .leftJoin(schema.users, eq(v.publishedBy, schema.users.id))
    .leftJoin(schema.artifactViewCounts, eq(schema.artifactViewCounts.versionId, v.id))
    .where(eq(v.artifactId, page.id))
    .orderBy(asc(v.version))
  const included = (n: number) => e.allVersions || n === page.currentVersion
  return {
    json: {
      slug: page.slug,
      title: page.title,
      address: artifactUrl(page.slug),
      workspace: org?.name ?? 'Personal',
      owner: owner ? { name: owner.name, email: owner.email } : null,
      folder: folder?.name ?? null,
      createdAt: iso(page.createdAt),
      updatedAt: iso(page.updatedAt),
      currentVersion: page.currentVersion,
      publishedWith: page.publishedWith,
      generalAccess: VISIBILITY_LABEL[page.visibility],
      // Whether a link is set up, never its key or password
      link: {
        on: page.visibility === 'link',
        expiresAt: iso(page.linkExpiresAt),
        passwordProtected: page.linkPasswordHash !== null,
        hasKey: page.linkToken !== null,
      },
      sharedWith: shares.map((s) => ({ email: s.email, role: s.role, sharedAt: iso(s.createdAt) })),
      versions: versions.map((r) => ({
        version: r.version,
        publishedAt: iso(r.createdAt),
        publishedBy: r.byName ?? r.byEmail ?? null,
        publishedWith: r.publishedWith,
        restoredFrom: r.restoredFrom,
        views: r.views ?? 0,
        included: included(r.version),
      })),
    },
    versions: versions.map((r) => r.version).filter(included),
  }
}

const author = alias(schema.users, 'export_author')
const resolver = alias(schema.users, 'export_resolver')

async function pageComments(pageId: string, e: DataExport) {
  const c = schema.artifactComments
  const rows = await db
    .select({ comment: c, authorName: author.name, resolverName: resolver.name })
    .from(c)
    .leftJoin(author, eq(c.authorId, author.id))
    .leftJoin(resolver, eq(c.resolvedBy, resolver.id))
    .where(eq(c.artifactId, pageId))
    .orderBy(asc(c.createdAt), asc(c.id))
  return rows.map(({ comment, authorName, resolverName }) => ({
    id: comment.id,
    replyTo: comment.parentId,
    author: authorName ?? null,
    ...(e.organizationId ? {} : { byYou: comment.authorId === e.userId }),
    body: comment.body,
    version: comment.version,
    postedWith: comment.postedWith,
    createdAt: iso(comment.createdAt),
    editedAt: iso(comment.editedAt),
    resolvedAt: iso(comment.resolvedAt),
    resolvedBy: comment.resolvedAt ? (resolverName ?? null) : null,
  }))
}

// Comments the person wrote on pages they don't own. A page is named only while they can open it.
async function commentsElsewhere(userId: string) {
  const [user] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId))
  const viewer: Viewer = { id: user.id, email: user.email, blockedOrgs: await blockedOrganizations(user.id) }
  const c = schema.artifactComments
  const rows = await db
    .select({ comment: c, page: a })
    .from(c)
    .innerJoin(a, eq(c.artifactId, a.id))
    .where(and(eq(c.authorId, userId), ne(a.ownerId, userId)))
    .orderBy(asc(c.createdAt), asc(c.id))
  const open = new Map<string, boolean>()
  const out = []
  for (const { comment, page } of rows) {
    if (!open.has(page.id)) open.set(page.id, (await accessLevel(page, viewer)) !== null)
    out.push({
      page: open.get(page.id) ? { slug: page.slug, title: page.title, address: artifactUrl(page.slug) } : null,
      id: comment.id,
      replyTo: comment.parentId,
      body: comment.body,
      version: comment.version,
      postedWith: comment.postedWith,
      createdAt: iso(comment.createdAt),
      editedAt: iso(comment.editedAt),
    })
  }
  return out
}

type Put = (path: string, content: Buffer, modified: Date) => Promise<void>

// Writes the next piece of the export and moves `p` past it: the README and account or organization,
// then for each page its page.json and comments and then one version at a time, then (for an
// account) the comments written elsewhere
async function writeNext(e: DataExport, p: Progress, put: Put) {
  const now = new Date(p.exportedAt)
  if (p.stage === 'start') {
    const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, e.userId))
    const [org] = e.organizationId
      ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, e.organizationId))
      : []
    await put('README.txt', Buffer.from(readme(e, user, org ?? null, p.exportedAt), 'utf8'), now)
    if (e.organizationId) await put('organization.json', json(await organizationJson(e.organizationId, p.exportedAt)), now)
    else await put('account.json', json(await accountJson(e.userId, p.exportedAt)), now)
    p.stage = 'pages'
    return
  }

  if (p.stage === 'pages') {
    if (p.page && p.versions.length) {
      const n = p.versions.shift()!
      await writeVersion(p.page, n, put)
      return
    }
    if (p.page) {
      p.after = p.page.id
      p.page = null
      p.pagesDone += 1
    }
    const [page] = await db
      .select()
      .from(a)
      .where(and(pagesOf(e), p.after ? gt(a.id, p.after) : undefined))
      .orderBy(asc(a.id))
      .limit(1)
    if (!page) {
      p.stage = e.organizationId ? 'finish' : 'comments'
      p.pagesTotal = Math.max(p.pagesTotal, p.pagesDone)
      return
    }
    const { json: meta, versions } = await pageJson(page, e)
    await put(`pages/${page.slug}/page.json`, json(meta), now)
    await put(`pages/${page.slug}/comments.json`, json(await pageComments(page.id, e)), now)
    p.page = { id: page.id, slug: page.slug }
    p.versions = versions
    return
  }

  if (p.stage === 'comments') {
    await put('comments.json', json(await commentsElsewhere(e.userId)), now)
    p.stage = 'finish'
  }
}

async function writeVersion(page: { id: string; slug: string }, n: number, put: Put) {
  const [v] = await db
    .select()
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, page.id), eq(schema.artifactVersions.version, n)))
  // Deleted since page.json was written: by retention, or with the page
  if (!v) return
  let tree: Awaited<ReturnType<typeof loadVersionTree>>
  try {
    tree = await loadVersionTree(v)
  } catch (err) {
    // A blob the storage sweep removed after the version was deleted, between the two reads above
    const [still] = await db.select({ id: schema.artifactVersions.id }).from(schema.artifactVersions).where(eq(schema.artifactVersions.id, v.id))
    if (!still) return
    throw err
  }
  const base = `pages/${page.slug}/versions/${n}/`
  await put(`${base}${ENTRY_PATH}`, Buffer.from(tree.html, 'utf8'), v.createdAt)
  for (const f of tree.files) await put(`${base}${f.path}`, f.content, v.createdAt)
}

type StepResult = 'more' | 'done' | 'busy' | 'failed'

// One step of building an export, for at most about `budgetMs`. 'busy' when another process holds it
// or it isn't being built.
export async function stepExport(id: string, budgetMs = STEP_MS): Promise<StepResult> {
  const lease = randomUUID()
  const [row] = await db
    .update(t)
    .set({ leaseId: lease, leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
    .where(and(eq(t.id, id), eq(t.status, 'building'), or(isNull(t.leaseUntil), lt(t.leaseUntil, sql`now()`))))
    .returning()
  if (!row) return 'busy'
  try {
    return (await build(row, lease, budgetMs)) ? 'done' : 'more'
  } catch (err) {
    // Another process took over after this one ran past its lease; it carries on from the last save
    if (err instanceof LeaseLost) return 'busy'
    const p = row.progress as Progress
    const failures = (p.failures ?? 0) + 1
    log.error('Building a data export failed', { err, exportId: id, failures })
    if (failures >= MAX_FAILURES) {
      await failExport(row)
      return 'failed'
    }
    // Tried again from where the last saved step left off, after a pause
    await db
      .update(t)
      .set({ progress: { ...p, failures }, leaseId: null, leaseUntil: sql`now() + interval '10 seconds'` })
      .where(and(eq(t.id, id), eq(t.leaseId, lease)))
    return 'more'
  }
}

class LeaseLost extends Error {}

async function build(row: DataExport, lease: string, budgetMs: number): Promise<boolean> {
  const started = Date.now()
  const before = row.progress as Progress
  const p: Progress = structuredClone(before)
  const key = zipKey(row.id)
  if (!p.uploadId) {
    p.uploadId = await startMultipart(key)
    // Saved at once, so the sweep knows the upload belongs to a live export
    const saved = await db
      .update(t)
      .set({ progress: p })
      .where(and(eq(t.id, row.id), eq(t.leaseId, lease)))
      .returning({ id: t.id })
    if (!saved.length) {
      await abortMultipart(key, p.uploadId)
      throw new LeaseLost()
    }
  }
  const uploadId = p.uploadId

  const pending: Buffer[] = []
  let pendingBytes = 0
  if (p.carry) {
    const carried = await getObject(p.carry)
    if (!carried) throw new Error(`The carried bytes of export ${row.id} are missing`)
    pending.push(carried)
    pendingBytes = carried.length
  }
  const writer = new ZipWriter({ offset: p.offset, entries: p.entries })
  const flush = async (force: boolean) => {
    if (pendingBytes === 0 || (!force && pendingBytes < PART_BYTES)) return
    const body = Buffer.concat(pending)
    pending.length = 0
    pendingBytes = 0
    const n = p.parts.length + 1
    p.parts.push({ n, etag: await uploadPart(key, uploadId, n, body) })
  }
  const put: Put = async (path, content, modified) => {
    const bytes = await writer.add(path, content, modified)
    pending.push(bytes)
    pendingBytes += bytes.length
    await flush(false)
  }

  // At least one piece per step, so every step gets somewhere
  while (p.stage !== 'finish') {
    await writeNext(row, p, put)
    if (Date.now() - started >= budgetMs) break
  }

  if (p.stage === 'finish') {
    const directory = Buffer.concat([row.directory, writer.takeDirectory()])
    const end = zipEnd(writer.entries, directory, writer.offset)
    pending.push(end)
    pendingBytes += end.length
    await flush(true)
    // Still ours: nobody else completes or deletes it in the meantime
    const [held] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, row.id), eq(t.leaseId, lease)))
    if (!held) throw new LeaseLost()
    await completeMultipart(key, uploadId, p.parts)
    const size = writer.offset + end.length
    const finishedAt = new Date()
    const [ready] = await db
      .update(t)
      .set({
        status: 'ready',
        progress: { ...p, carry: null, entries: writer.entries, offset: size },
        directory: Buffer.alloc(0),
        size,
        finishedAt,
        expiresAt: new Date(finishedAt.getTime() + EXPORT_HOURS * HOUR),
        leaseId: null,
        leaseUntil: null,
      })
      .where(and(eq(t.id, row.id), eq(t.leaseId, lease)))
      .returning()
    await deleteCarried(row.id).catch((err) => log.warn('Could not delete the pieces of a data export', { err, exportId: row.id }))
    if (ready) await notifyReady(ready)
    return true
  }

  // Bytes too few to be a part wait in the bucket, under a key of their own, so a step that dies
  // before saving leaves the last saved carry as it was
  let carry: string | null = null
  if (pendingBytes > 0) {
    carry = `${prefixOf(row.id)}carry-${writer.offset}`
    await putObject(carry, Buffer.concat(pending))
  }
  const saved = await db
    .update(t)
    .set({
      progress: { ...p, offset: writer.offset, entries: writer.entries, carry, failures: 0 },
      directory: sql`${t.directory} || ${writer.takeDirectory()}::bytea`,
      leaseId: null,
      leaseUntil: null,
    })
    .where(and(eq(t.id, row.id), eq(t.leaseId, lease)))
    .returning({ id: t.id })
  if (!saved.length) throw new LeaseLost()
  if (before.carry && before.carry !== carry) await deleteObjects([before.carry]).catch(() => {})
  return false
}

async function deleteCarried(id: string) {
  const keys: string[] = []
  for await (const o of listObjects(`${prefixOf(id)}carry-`)) keys.push(o.key)
  await deleteObjects(keys)
}

// Gives up on an export: its upload and pieces are removed, and the try doesn't count against the limit
async function failExport(row: DataExport) {
  const p = row.progress as Progress
  await db
    .update(t)
    .set({ status: 'failed', error: 'The export could not be finished. Try again.', leaseId: null, leaseUntil: null, directory: Buffer.alloc(0) })
    .where(eq(t.id, row.id))
  await refund('data-export', limitKey(row)).catch(() => {})
  await removeFiles([{ id: row.id, uploadId: p.uploadId }]).catch((err) => log.warn('Could not delete the pieces of a data export', { err, exportId: row.id }))
}

async function notifyReady(e: DataExport) {
  if (!mailEnabled()) return
  const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, e.userId))
  const [org] = e.organizationId
    ? await db
        .select({ name: schema.organizations.name, slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, e.organizationId))
    : []
  if (!user) return
  // To the settings page rather than the file: the download needs the person to be signed in anyway
  const link = org ? `${env.appUrl}/organizations/${encodeURIComponent(org.slug)}/settings#export` : `${env.appUrl}/settings#export`
  await sendExportReady(user.email, { organization: org?.name ?? null, link, hours: EXPORT_HOURS }).catch((err) =>
    log.warn('Could not email that a data export is ready', { err, exportId: e.id }),
  )
}

// Runs steps until the export is done, fails or another process has it
export async function buildExport(id: string): Promise<StepResult> {
  for (;;) {
    const result = await stepExport(id)
    if (result !== 'more') return result
  }
}

// Whether this process builds exports on its own (the long-running server) or steps them when their
// status is asked for (serverless)
let inProcess = false

export function buildExportsInProcess(on = true) {
  inProcess = on
}

export const buildsInProcess = () => inProcess

// Starts building in this process, when it is one that outlives the request
export function startBuilding(id: string) {
  if (!inProcess) return
  void buildExport(id).catch((err) => log.error('Building a data export failed', { err, exportId: id }))
}

// Continues exports nobody is building, e.g. after a restart, for up to `budgetMs`
export async function resumeExports({ budgetMs = Number.POSITIVE_INFINITY } = {}): Promise<number> {
  const started = Date.now()
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.status, 'building'), or(isNull(t.leaseUntil), lt(t.leaseUntil, sql`now()`))))
    .orderBy(asc(t.createdAt))
  let steps = 0
  for (const { id } of rows) {
    for (;;) {
      const left = budgetMs - (Date.now() - started)
      if (left <= 0) return steps
      const result = await stepExport(id, Math.min(STEP_MS, left))
      steps += 1
      if (result !== 'more') break
    }
  }
  return steps
}

export function scheduleExportResumes() {
  let running = false
  const run = () => {
    if (running) return
    running = true
    resumeExports()
      .catch((err) => log.error('Resuming data exports failed', { err }))
      .finally(() => {
        running = false
      })
  }
  setInterval(run, 60_000).unref()
}

async function removeFiles(rows: { id: string; uploadId: string | null }[]) {
  for (const r of rows) {
    if (r.uploadId) await abortMultipart(zipKey(r.id), r.uploadId)
    const keys: string[] = []
    for await (const o of listObjects(prefixOf(r.id))) keys.push(o.key)
    await deleteObjects(keys)
  }
}

// An account's exports, as it is deleted: the rows go with it, and their files go now rather than
// at the next sweep
export async function exportsOf(userId: string) {
  const rows = await db.select({ id: t.id, progress: t.progress }).from(t).where(eq(t.userId, userId))
  return rows.map((r) => ({ id: r.id, uploadId: (r.progress as Progress).uploadId }))
}

export async function deleteExportFiles(rows: { id: string; uploadId: string | null }[]) {
  await removeFiles(rows).catch((err) => log.warn('Could not delete the files of data exports', { err }))
}

// Run with the storage sweep: deletes expired exports, failed ones after a day and builds abandoned
// for a week, with their files, and files and uploads under exports/ that no export owns (their
// account or organization was deleted). Those are left an hour, since a build may have just started.
export async function sweepExports(now = new Date()): Promise<number> {
  const day = new Date(now.getTime() - EXPORT_HOURS * HOUR)
  const gone = await db
    .delete(t)
    .where(
      or(
        and(eq(t.status, 'ready'), lt(t.expiresAt, now)),
        and(eq(t.status, 'failed'), lt(t.createdAt, day)),
        and(eq(t.status, 'building'), lt(t.createdAt, new Date(now.getTime() - ABANDONED_MS))),
      ),
    )
    .returning({ id: t.id, progress: t.progress })
  await removeFiles(gone.map((r) => ({ id: r.id, uploadId: (r.progress as Progress).uploadId })))

  const live = new Map((await db.select({ id: t.id, status: t.status, progress: t.progress }).from(t)).map((r) => [r.id, r]))
  const grace = now.getTime() - HOUR
  const orphans: string[] = []
  for await (const o of listObjects(EXPORTS)) {
    const id = o.key.slice(EXPORTS.length).split('/')[0]
    if (!live.has(id) && o.lastModified.getTime() < grace) orphans.push(o.key)
  }
  await deleteObjects(orphans)
  let uploads = 0
  for await (const u of listMultipartUploads(EXPORTS)) {
    const row = live.get(u.key.slice(EXPORTS.length).split('/')[0])
    const ours = row?.status === 'building' && (row.progress as Progress).uploadId === u.uploadId
    if (!ours && u.initiated.getTime() < grace) {
      await abortMultipart(u.key, u.uploadId)
      uploads += 1
    }
  }
  return gone.length + orphans.length + uploads
}
