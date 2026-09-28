import { and, asc, count, eq, exists, ne, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { audit, securityLog } from '../audit.js'
import type { AuthEnv } from '../auth/session.js'
import { hashToken, randomToken } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env } from '../env.js'
import { activeAdminCount, isInstanceAdmin, lockAdmins, newAccountFields, removeMembership, revokeAccess } from '../instance.js'
import { enterpriseRequired, hasEnterprise, requireEnterprise } from '../license.js'
import { defineLimit, hit, waitText } from '../limits.js'
import { isEmail, UUID_RE } from '../validation.js'

// SCIM 2.0 (RFC 7643, RFC 7644) at /scim/v2, for an IdP (Okta, Entra ID) to create, update and
// deactivate accounts. Users only: the app has no groups for SCIM Groups to map to. Deleting a user
// suspends the account instead, so the pages it owns stay; an instance admin can delete it for good.
//
// A token made for an organization reaches only that organization's members: it lists, reads and
// changes them, and creates accounts in it. Suspending an account and changing its name or email
// address reach beyond the organization (the person's own pages, other organizations, the server),
// so a token does that only to accounts that are in no other organization and aren't instance
// admins. Deactivating anyone else takes them out of the token's organization instead. A token
// without an organization, which only an instance admin can make, reaches every account.
//
// Errors here are SCIM Error messages ({ schemas, status, scimType?, detail }, RFC 7644 section 3.12)
// instead of the app's usual { error }: IdPs parse this shape, and nobody reads these in the app.

const SCIM_JSON = 'application/scim+json'
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
export const TOKEN_PREFIX = 'scim_'
const MAX_PAGE = 200
const USED_EVERY = 60 * 1000

// Requests one SCIM token makes; a full import from an IdP stays well under it
defineLimit('scim', { max: 2000, seconds: 10 * 60 })

type ScimToken = typeof schema.scimTokens.$inferSelect
type ScimEnv = { Variables: { scimToken: ScimToken } }

type ScimType = 'invalidFilter' | 'invalidValue' | 'invalidSyntax' | 'uniqueness' | 'mutability' | 'noTarget' | 'invalidPath'

function scimError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 500, detail: string, scimType?: ScimType, headers: Record<string, string> = {}) {
  const body = { schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail }
  return c.body(JSON.stringify(body), status, { 'Content-Type': SCIM_JSON, ...headers })
}

function scimJson(c: Context, body: unknown, status: 200 | 201 = 200, headers: Record<string, string> = {}) {
  return c.body(JSON.stringify(body), status, { 'Content-Type': SCIM_JSON, ...headers })
}

export const scim = new Hono<ScimEnv>()

const authenticate = createMiddleware<ScimEnv>(async (c, next) => {
  // The hosted service has no SCIM; it answers as if the path didn't exist
  if (!env.selfHosted) return scimError(c, 404, 'Not found.')
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  const [token] = match?.[1].startsWith(TOKEN_PREFIX)
    ? await db
        .select()
        .from(schema.scimTokens)
        .where(eq(schema.scimTokens.tokenHash, hashToken(match[1])))
    : []
  if (!token)
    return scimError(c, 401, 'The SCIM token is missing or no longer valid. Make a new one under Server admin.', undefined, { 'WWW-Authenticate': 'Bearer' })
  if (!(await hasEnterprise())) return scimError(c, 403, enterpriseRequired.error)
  const wait = await hit('scim', token.id)
  if (wait !== null) return scimError(c, 429, `Too many SCIM requests. Try again in ${waitText(wait)}.`, undefined, { 'Retry-After': String(wait) })
  if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > USED_EVERY) {
    await db.update(schema.scimTokens).set({ lastUsedAt: new Date() }).where(eq(schema.scimTokens.id, token.id))
  }
  c.set('scimToken', token)
  await next()
})
scim.use(authenticate)

scim.get('/ServiceProviderConfig', (c) =>
  scimJson(c, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${env.appUrl}/docs/scim`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'A SCIM token from Server admin', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${env.appUrl}/scim/v2/ServiceProviderConfig` },
  }),
)

scim.get('/ResourceTypes', (c) =>
  scimJson(c, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: USER_SCHEMA,
        meta: { resourceType: 'ResourceType', location: `${env.appUrl}/scim/v2/ResourceTypes/User` },
      },
    ],
  }),
)

type Row = { user: User; scim: typeof schema.scimUsers.$inferSelect | null }

function resource(row: Row) {
  const { user, scim: s } = row
  const formatted = user.name ?? ([s?.givenName, s?.familyName].filter(Boolean).join(' ') || null)
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(s?.externalId ? { externalId: s.externalId } : {}),
    userName: s?.userName ?? user.email,
    name: {
      ...(formatted ? { formatted } : {}),
      ...(s?.givenName ? { givenName: s.givenName } : {}),
      ...(s?.familyName ? { familyName: s.familyName } : {}),
    },
    ...(user.name ? { displayName: user.name } : {}),
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: !user.suspendedAt,
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: (s?.updatedAt ?? user.createdAt).toISOString(),
      location: `${env.appUrl}/scim/v2/Users/${user.id}`,
    },
  }
}

const selectRows = () =>
  db.select({ user: schema.users, scim: schema.scimUsers }).from(schema.users).leftJoin(schema.scimUsers, eq(schema.scimUsers.userId, schema.users.id))

// The accounts a token reaches: the members of its organization, or all of them
function reach(token: ScimToken): SQL | undefined {
  if (!token.organizationId) return undefined
  return exists(
    db
      .select({ one: sql`1` })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.organizationId, token.organizationId))),
  )
}

async function findRow(token: ScimToken, id: string): Promise<Row | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await selectRows().where(and(eq(schema.users.id, id), reach(token)))
  return row ?? null
}

const FILTER_RE = /^\s*(userName|externalId|id|emails(?:\.value)?|emails\[type eq "work"\]\.value)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i

// The filters IdPs send to match an account before creating it: `userName eq "…"`, and also
// externalId, id and the email address
function parseFilter(filter: string): SQL | null | 'invalid' {
  if (!filter.trim()) return null
  const m = FILTER_RE.exec(filter)
  if (!m) return 'invalid'
  const value = m[2].replace(/\\(.)/g, '$1')
  const attr = m[1].toLowerCase()
  if (attr === 'username') return sql`lower(coalesce(${schema.scimUsers.userName}, ${schema.users.email})) = ${value.toLowerCase()}`
  if (attr === 'externalid') return eq(schema.scimUsers.externalId, value)
  if (attr === 'id') return UUID_RE.test(value) ? eq(schema.users.id, value) : sql`false`
  return eq(schema.users.email, value.toLowerCase())
}

scim.get('/Users', async (c) => {
  const filter = parseFilter(c.req.query('filter') ?? '')
  if (filter === 'invalid') return scimError(c, 400, 'Only "eq" filters on userName, externalId, id or emails are supported.', 'invalidFilter')
  const startIndex = Math.max(1, Number.parseInt(c.req.query('startIndex') ?? '1', 10) || 1)
  const requested = Number.parseInt(c.req.query('count') ?? String(MAX_PAGE), 10)
  const size = Math.min(MAX_PAGE, Math.max(0, Number.isNaN(requested) ? MAX_PAGE : requested))
  const where = and(filter ?? undefined, reach(c.get('scimToken')))
  const [{ total }] = await db
    .select({ total: count() })
    .from(schema.users)
    .leftJoin(schema.scimUsers, eq(schema.scimUsers.userId, schema.users.id))
    .where(where)
  const rows = size
    ? await selectRows()
        .where(where)
        .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
        .limit(size)
        .offset(startIndex - 1)
    : []
  return scimJson(c, { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map(resource) })
})

scim.get('/Users/:id', async (c) => {
  const row = await findRow(c.get('scimToken'), c.req.param('id'))
  if (!row) return scimError(c, 404, 'No user with this id.', 'noTarget')
  return scimJson(c, resource(row))
})

// What a User resource sets, from POST, PUT or PATCH. Fields that are undefined stay as they are.
type Changes = {
  userName?: string
  email?: string
  displayName?: string | null
  givenName?: string | null
  familyName?: string | null
  externalId?: string | null
  active?: boolean
}

class ScimProblem extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly scimType?: ScimType,
  ) {
    super(message)
  }
}

const text = (v: unknown, max = 256): string | null | undefined => {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

// Entra ID sends booleans as the strings "True" and "False"
function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
  return undefined
}

function primaryEmail(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined
  const list = emails.filter((e): e is { value: string; primary?: unknown; type?: unknown } => typeof e?.value === 'string')
  const chosen = list.find((e) => bool(e.primary) === true) ?? list.find((e) => e.type === 'work') ?? list[0]
  return chosen?.value.trim()
}

function fromResource(body: Record<string, unknown>): Changes {
  const name = (body.name ?? {}) as Record<string, unknown>
  return {
    userName: text(body.userName) ?? undefined,
    email: primaryEmail(body.emails),
    displayName: text(body.displayName) ?? text(name.formatted),
    givenName: text(name.givenName),
    familyName: text(name.familyName),
    externalId: text(body.externalId),
    active: bool(body.active),
  }
}

// One PATCH operation's path and value onto the changes. Attributes the app doesn't keep (title,
// phone numbers, addresses...) are ignored, since IdPs send them whether or not they are supported.
function applyPath(changes: Changes, op: string, path: string, value: unknown) {
  const remove = op === 'remove'
  const p = path.trim()
  const lower = p.toLowerCase()
  if (lower === 'active') changes.active = remove ? undefined : bool(value)
  else if (lower === 'username') changes.userName = remove ? undefined : (text(value) ?? undefined)
  else if (lower === 'displayname' || lower === 'name.formatted') changes.displayName = remove ? null : text(value)
  else if (lower === 'name.givenname') changes.givenName = remove ? null : text(value)
  else if (lower === 'name.familyname') changes.familyName = remove ? null : text(value)
  else if (lower === 'externalid') changes.externalId = remove ? null : text(value)
  else if (lower === 'name' && value && typeof value === 'object') {
    const n = value as Record<string, unknown>
    if ('givenName' in n) changes.givenName = text(n.givenName)
    if ('familyName' in n) changes.familyName = text(n.familyName)
    if ('formatted' in n) changes.displayName = text(n.formatted)
  } else if (/^emails(\[.*\])?(\.value)?$/i.test(p) && !remove) {
    const email = Array.isArray(value) ? primaryEmail(value) : typeof value === 'string' ? value.trim() : undefined
    if (email) changes.email = email
  }
}

function fromPatch(body: Record<string, unknown>): Changes {
  const schemas = Array.isArray(body.schemas) ? body.schemas : []
  if (!schemas.includes(PATCH_SCHEMA) || !Array.isArray(body.Operations)) {
    throw new ScimProblem(400, 'Send a PatchOp with Operations.', 'invalidSyntax')
  }
  const changes: Changes = {}
  for (const raw of body.Operations as Record<string, unknown>[]) {
    const op = typeof raw?.op === 'string' ? raw.op.toLowerCase() : ''
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw new ScimProblem(400, 'Each operation is add, replace or remove.', 'invalidSyntax')
    if (typeof raw.path === 'string' && raw.path) applyPath(changes, op, raw.path, raw.value)
    else if (op !== 'remove' && raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)) {
      // Okta: { op: "replace", value: { active: false } }; Entra ID may also use dotted keys
      for (const [key, value] of Object.entries(raw.value as Record<string, unknown>)) applyPath(changes, op, key, value)
    } else if (op !== 'remove') throw new ScimProblem(400, 'An operation without a path needs an object value.', 'invalidValue')
  }
  return changes
}

function checkEmail(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const e = email.toLowerCase()
  if (!isEmail(e)) throw new ScimProblem(400, `${email} is not an email address.`, 'invalidValue')
  return e
}

const displayFrom = (c: Changes) => c.displayName ?? ([c.givenName, c.familyName].filter(Boolean).join(' ') || null)

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Suspends or restores an account the way Server admin does: suspending signs it out everywhere
async function setActive(tx: Tx, user: User, active: boolean): Promise<Partial<User>> {
  if (active) return user.suspendedAt ? { suspendedAt: null } : {}
  if (user.suspendedAt) return {}
  if (isInstanceAdmin(user) && (await activeAdminCount(tx)) <= 1) {
    throw new ScimProblem(409, 'This is the only admin of this server, so it can’t be deactivated. Make someone else an admin first.', 'mutability')
  }
  await revokeAccess(tx, user)
  return { suspendedAt: new Date() }
}

async function emailTaken(tx: Tx, email: string, except?: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.email, email), except ? ne(schema.users.id, except) : undefined))
  return Boolean(row)
}

async function userNameTaken(tx: Tx, userName: string, except?: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.scimUsers.userId })
    .from(schema.scimUsers)
    .where(and(sql`lower(${schema.scimUsers.userName}) = ${userName.toLowerCase()}`, except ? ne(schema.scimUsers.userId, except) : undefined))
  return Boolean(row)
}

async function create(token: ScimToken, changes: Changes): Promise<string> {
  if (!changes.userName) throw new ScimProblem(400, 'userName is required.', 'invalidValue')
  const email = checkEmail(changes.email ?? changes.userName)
  if (!email) throw new ScimProblem(400, 'Send an email address in emails or as the userName.', 'invalidValue')
  const { user, joined } = await db.transaction(async (tx) => {
    await lockAdmins(tx)
    if ((await emailTaken(tx, email)) || (await userNameTaken(tx, changes.userName!))) {
      throw new ScimProblem(409, 'An account with this userName or email address already exists.', 'uniqueness')
    }
    const [user] = await tx
      .insert(schema.users)
      .values({ email, name: displayFrom(changes), ...(await newAccountFields(tx)), suspendedAt: changes.active === false ? new Date() : null })
      .returning()
    await tx.insert(schema.scimUsers).values({
      userId: user.id,
      userName: changes.userName!,
      externalId: changes.externalId ?? null,
      givenName: changes.givenName ?? null,
      familyName: changes.familyName ?? null,
    })
    const joined = token.organizationId
      ? await tx
          .insert(schema.memberships)
          .values({ userId: user.id, organizationId: token.organizationId, role: 'member' })
          .onConflictDoNothing()
          .returning({ role: schema.memberships.role })
      : []
    return { user, joined: joined.length > 0 }
  })
  // The IdP did it, so there is no actor
  if (joined) {
    audit({
      action: 'member.joined',
      organizationId: token.organizationId,
      actor: null,
      target: { type: 'member', id: user.id, label: user.email },
      details: { role: 'member', via: 'SCIM', token: token.name },
    })
  }
  return user.id
}

// Whether a token may suspend this account and change its name and email address: see the top of this file
async function manages(tx: Tx, token: ScimToken, user: User): Promise<boolean> {
  if (!token.organizationId) return true
  if (user.isAdmin) return false
  const [other] = await tx
    .select({ id: schema.memberships.organizationId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, user.id), ne(schema.memberships.organizationId, token.organizationId)))
    .limit(1)
  return !other
}

// Deactivating someone the token doesn't manage: they leave the token's organization, as when an
// owner removes them, and keep their account
async function removeFromOrganization(tx: Tx, organizationId: string, userId: string) {
  const [target] = await tx
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.userId, userId)))
    .for('update')
  if (!target) return null
  if (target.role === 'owner') {
    const [{ owners }] = await tx
      .select({ owners: count() })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.role, 'owner')))
    if (owners <= 1)
      throw new ScimProblem(409, 'This is the only owner of the organization, so it can’t be removed. Make someone else an owner first.', 'mutability')
  }
  await removeMembership(tx, organizationId, userId)
  return target.role
}

// PUT replaces what the resource says (replace = true); PATCH changes only what it names. Answers
// false when the person was taken out of the token's organization instead of being changed.
async function update(token: ScimToken, id: string, changes: Changes, replace: boolean): Promise<boolean> {
  const { user, set, removed } = await db.transaction(async (tx) => {
    await lockAdmins(tx)
    const [user] = await tx
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, id), reach(token)))
      .for('update')
    if (!user) throw new ScimProblem(404, 'No user with this id.', 'noTarget')
    if (!(await manages(tx, token, user))) {
      // Name and address changes are left out rather than refused, so the IdP's routine updates go through
      const removed = changes.active === false ? await removeFromOrganization(tx, token.organizationId!, id) : null
      return { user, set: {} as Partial<User>, removed }
    }
    const [current] = await tx.select().from(schema.scimUsers).where(eq(schema.scimUsers.userId, id))

    const set: Partial<User> = {}
    const email = checkEmail(changes.email)
    if (email && email !== user.email) {
      if (await emailTaken(tx, email, id)) throw new ScimProblem(409, 'Another account already uses this email address.', 'uniqueness')
      set.email = email
    }
    if (changes.userName && (await userNameTaken(tx, changes.userName, id))) {
      throw new ScimProblem(409, 'Another account already uses this userName.', 'uniqueness')
    }
    const next = {
      userName: changes.userName ?? current?.userName ?? user.email,
      externalId: changes.externalId !== undefined ? changes.externalId : replace ? null : (current?.externalId ?? null),
      givenName: changes.givenName !== undefined ? changes.givenName : replace ? null : (current?.givenName ?? null),
      familyName: changes.familyName !== undefined ? changes.familyName : replace ? null : (current?.familyName ?? null),
    }
    const nameChanged = changes.displayName !== undefined || changes.givenName !== undefined || changes.familyName !== undefined
    if (nameChanged) set.name = changes.displayName ?? ([next.givenName, next.familyName].filter(Boolean).join(' ') || null)
    if (changes.active !== undefined) Object.assign(set, await setActive(tx, user, changes.active))

    if (Object.keys(set).length) await tx.update(schema.users).set(set).where(eq(schema.users.id, id))
    await tx
      .insert(schema.scimUsers)
      .values({ userId: id, ...next })
      .onConflictDoUpdate({ target: schema.scimUsers.userId, set: { ...next, updatedAt: new Date() } })
    return { user, set, removed: null }
  })
  if (removed) {
    audit({
      action: 'member.removed',
      organizationId: token.organizationId,
      actor: null,
      target: { type: 'member', id: user.id, label: user.email },
      details: { role: removed, via: 'SCIM', token: token.name },
    })
    return false
  }
  // Told to every organization the account is in
  if ('suspendedAt' in set) {
    audit({
      action: set.suspendedAt ? 'member.suspended' : 'member.reactivated',
      memberOf: user.id,
      actor: null,
      target: { type: 'member', id: user.id, label: set.email ?? user.email },
      details: { via: 'SCIM', token: token.name },
    })
  }
  return true
}

// What PUT and PATCH answer: the account as it is now, or, for someone just taken out of the
// token's organization, as the IdP left it (deactivated)
async function updated(c: Context<ScimEnv>, id: string, kept: boolean) {
  if (kept) return scimJson(c, resource((await findRow(c.get('scimToken'), id))!))
  const [row] = await selectRows().where(eq(schema.users.id, id))
  return scimJson(c, { ...resource(row), active: false })
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null)
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ScimProblem(400, 'Send a JSON object.', 'invalidSyntax')
  return b as Record<string, unknown>
}

function handle(c: Context, err: unknown) {
  if (err instanceof ScimProblem) return scimError(c, err.status, err.message, err.scimType)
  throw err
}

scim.post('/Users', async (c) => {
  try {
    const id = await create(c.get('scimToken'), fromResource(await body(c)))
    const row = (await findRow(c.get('scimToken'), id))!
    return scimJson(c, resource(row), 201, { Location: `${env.appUrl}/scim/v2/Users/${id}` })
  } catch (err) {
    return handle(c, err)
  }
})

scim.put('/Users/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return scimError(c, 404, 'No user with this id.', 'noTarget')
  try {
    const changes = fromResource(await body(c))
    if (!changes.userName) throw new ScimProblem(400, 'userName is required.', 'invalidValue')
    return updated(c, id, await update(c.get('scimToken'), id, changes, true))
  } catch (err) {
    return handle(c, err)
  }
})

scim.patch('/Users/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return scimError(c, 404, 'No user with this id.', 'noTarget')
  try {
    return updated(c, id, await update(c.get('scimToken'), id, fromPatch(await body(c)), false))
  } catch (err) {
    return handle(c, err)
  }
})

// Deactivates rather than deletes: the account's pages and organizations stay, and an instance admin
// can restore or delete it under Server admin. Someone the token doesn't manage leaves its
// organization instead.
scim.delete('/Users/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return scimError(c, 404, 'No user with this id.', 'noTarget')
  try {
    await update(c.get('scimToken'), id, { active: false }, false)
    return c.body(null, 204)
  } catch (err) {
    return handle(c, err)
  }
})

scim.all('*', (c) => scimError(c, 404, 'Not found. This server supports /Users only.'))

// The instance admin's SCIM tokens, under /api/admin/scim
export const scimAdmin = new Hono<AuthEnv>()
scimAdmin.use(async (c, next) => {
  if (!env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  const user = c.get('user')
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!isInstanceAdmin(user)) return c.json({ error: 'Only instance admins can open this.', code: 'not_admin' }, 403)
  await next()
})
scimAdmin.use(requireEnterprise)

async function describeTokens() {
  const [tokens, orgs] = await Promise.all([
    db
      .select({
        id: schema.scimTokens.id,
        name: schema.scimTokens.name,
        organizationId: schema.scimTokens.organizationId,
        organizationName: schema.organizations.name,
        createdAt: schema.scimTokens.createdAt,
        lastUsedAt: schema.scimTokens.lastUsedAt,
      })
      .from(schema.scimTokens)
      .leftJoin(schema.organizations, eq(schema.scimTokens.organizationId, schema.organizations.id))
      .orderBy(asc(schema.scimTokens.createdAt)),
    db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).orderBy(schema.organizations.name).limit(200),
  ])
  return {
    baseUrl: `${env.appUrl}/scim/v2`,
    organizations: orgs,
    tokens: tokens.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null })),
  }
}

scimAdmin.get('/', async (c) => c.json(await describeTokens()))

// { name, organizationId? } → the token, shown once
scimAdmin.post('/tokens', async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
  if (!name || name.length > 60) return c.json({ error: 'Name the token, up to 60 characters, for example Okta.', field: 'name' }, 400)
  let organizationId: string | null = null
  if (typeof b.organizationId === 'string' && b.organizationId) {
    const [org] = UUID_RE.test(b.organizationId)
      ? await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, b.organizationId))
      : []
    if (!org) return c.json({ error: 'Choose an organization from the list.', field: 'organizationId' }, 400)
    organizationId = org.id
  }
  const token = TOKEN_PREFIX + randomToken()
  const [row] = await db
    .insert(schema.scimTokens)
    .values({ name, organizationId, tokenHash: hashToken(token), createdBy: c.get('user')!.id })
    .returning({ id: schema.scimTokens.id })
  securityLog('scim_token.created', { actorId: c.get('user')!.id, targetId: row.id, organizationId })
  return c.json({ token, ...(await describeTokens()) }, 201)
})

scimAdmin.delete('/tokens/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = UUID_RE.test(id) ? await db.delete(schema.scimTokens).where(eq(schema.scimTokens.id, id)).returning({ id: schema.scimTokens.id }) : []
  if (deleted.length) securityLog('scim_token.revoked', { actorId: c.get('user')!.id, targetId: id })
  return c.json(await describeTokens())
})
