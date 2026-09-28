import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { requireUser, type AuthEnv, type SessionUser } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { DataExport } from '../db/schema.js'
import {
  buildsInProcess,
  createExport,
  describeExport,
  exportFilename,
  findExport,
  latestExport,
  limitKey,
  signatureMatches,
  startBuilding,
  stepExport,
  zipKey,
} from '../exports.js'
import { limitRequest } from '../limits.js'
import { directUploads, presignDownload, streamObject } from '../storage.js'
import { UUID_RE } from '../validation.js'

// Data exports, mounted at /api/exports: an account's own (no organizationId) or, for its owners, an
// organization's. Organizations the person doesn't own look missing, like everywhere else.
export const exportsApi = new Hono<AuthEnv>()

const NOT_FOUND = { error: 'Not found' }
// Browsers get a link straight to the bucket for this long; the export's own expiry is checked first
const BUCKET_LINK_SECONDS = 300

// The organization's slug when this person owns it and may use it
async function ownedOrganization(user: SessionUser, organizationId: string): Promise<string | null> {
  if (!UUID_RE.test(organizationId) || user.blockedOrgs.includes(organizationId)) return null
  const [row] = await db
    .select({ role: schema.memberships.role, slug: schema.organizations.slug })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.userId, user.id)))
  return row?.role === 'owner' ? row.slug : null
}

// organizationId from the query or body: null for the account, a string for an organization, or
// undefined when it is neither
function scopeOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' ? value : undefined
}

exportsApi.get('/', requireUser, async (c) => {
  const user = c.get('user')!
  const organizationId = scopeOf(c.req.query('organizationId'))
  if (organizationId === undefined || (organizationId && !(await ownedOrganization(user, organizationId)))) return c.json(NOT_FOUND, 404)
  let latest = await latestExport(user.id, organizationId)
  // Without a long-running process, asking how the build is going is what moves it on (src/exports.ts)
  if (latest?.status === 'building' && !buildsInProcess()) {
    await stepExport(latest.id)
    latest = await latestExport(user.id, organizationId)
  }
  return c.json({ export: latest ? await describeExport(latest) : null })
})

// { organizationId?: string | null, versions: 'all' | 'current' }
exportsApi.post('/', requireUser, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { organizationId?: unknown; versions?: unknown } | null
  const organizationId = scopeOf(body?.organizationId)
  if (organizationId === undefined || (organizationId && !(await ownedOrganization(user, organizationId)))) return c.json(NOT_FOUND, 404)
  if (body?.versions !== 'all' && body?.versions !== 'current')
    return c.json({ error: 'Choose every version or only the current one.', field: 'versions' }, 400)

  const latest = await latestExport(user.id, organizationId)
  if (latest?.status === 'building')
    return c.json({ error: 'An export is already being built. Wait for it to finish.', export: await describeExport(latest) }, 409)
  const busy = await limitRequest(c, 'data-export', limitKey({ userId: user.id, organizationId }), 'An export was made a short time ago.')
  if (busy) return busy

  const created = await createExport(user.id, organizationId, body.versions === 'all')
  startBuilding(created.id)
  return c.json({ export: await describeExport(created) }, 202)
})

function notFound(c: Context) {
  return c.json(NOT_FOUND, 404, { 'Cache-Control': 'no-store' })
}

// GET /api/exports/:id/download?sig=… The link from the settings page. It works only for the person
// who asked for the export, signed in, until it expires; organization exports only while they still
// own the organization. Anyone else gets a 404.
exportsApi.get('/:id/download', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!user || !UUID_RE.test(id)) return notFound(c)
  const e: DataExport | null = await findExport(id)
  if (!e || e.userId !== user.id || e.status !== 'ready' || !e.expiresAt || e.expiresAt <= new Date()) return notFound(c)
  if (!(await signatureMatches(e, c.req.query('sig') ?? ''))) return notFound(c)
  let orgSlug: string | null = null
  if (e.organizationId) {
    orgSlug = await ownedOrganization(user, e.organizationId)
    if (!orgSlug) return notFound(c)
  }
  const filename = exportFilename(e, orgSlug)
  const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }

  // Straight from the bucket when browsers can reach it: a big file never passes through the API,
  // which on a serverless host couldn't send it in time
  if (directUploads()) return c.body(null, 302, { ...headers, Location: await presignDownload(zipKey(e.id), filename, BUCKET_LINK_SECONDS) })

  const object = await streamObject(zipKey(e.id))
  if (!object) return notFound(c)
  return c.body(object.body, 200, {
    ...headers,
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    ...(object.size !== null ? { 'Content-Length': String(object.size) } : {}),
  })
})
