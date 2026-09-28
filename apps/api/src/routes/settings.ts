import { and, asc, count, eq, gt, inArray, max, ne, sql } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.js'
import { twoFactorRequiredError } from '../auth/factors.js'
import { requireRecentSignIn, requireUser, startSession, type AuthEnv } from '../auth/session.js'
import { track } from '../analytics.js'
import { db, schema } from '../db/index.js'
import { deleteExportFiles, exportsOf } from '../exports.js'
import { forgetAccounts, isLastAdmin, lastAdminError } from '../instance.js'
import { clearHits, hit, limitRequest, tooManyRequests, waitText } from '../limits.js'
import { auditToken, checkExpiry, checkTokenName, createToken, describeToken, revokeToken, tokensOf } from '../tokens.js'
import { CONTROL_CHARS_ERROR, hasControlChars, UUID_RE } from '../validation.js'

// Account settings, mounted at /api/me next to GET /api/me
export const settings = new Hono<AuthEnv>()
settings.use(requireUser)

settings.patch('/', async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 80) return c.json({ error: 'Use 1 to 80 characters for your name.', field: 'name' }, 400)
  if (hasControlChars(name)) return c.json({ error: CONTROL_CHARS_ERROR, field: 'name' }, 400)
  await db.update(schema.users).set({ name }).where(eq(schema.users.id, user.id))
  return c.json({ name })
})

// { currentPassword, password }. Changing a password needs the current one. Adding the first one
// needs a recent sign-in instead, through the way the account signs in now (an email link, Google,
// single sign-on or a passkey): otherwise a session cookie someone else got hold of could add a
// password, sign in with it for a fresh session, and add a second factor of their own.
// Other devices are signed out; this one gets a fresh session.
const firstPasswordNeedsRecentSignIn: MiddlewareHandler<AuthEnv> = (c, next) => (c.get('user')!.passwordHash ? next() : requireRecentSignIn(c, next))

settings.put('/password', firstPasswordNeedsRecentSignIn, async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { currentPassword?: unknown; password?: unknown } | null
  if (user.passwordHash) {
    const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    // Counted with wrong passwords at sign-in, and before the check, so it can't be used to guess faster
    const locked = await hit('password', user.email)
    if (locked) {
      return tooManyRequests(c, `Too many wrong passwords. Try again in ${waitText(locked)}.`, locked, { code: 'too_many_attempts', field: 'currentPassword' })
    }
    if (!(await verifyPassword(current, user.passwordHash))) return c.json({ error: 'Your current password is wrong.', field: 'currentPassword' }, 400)
    await clearHits('password', user.email)
  }
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)
  const passwordHash = await hashPassword(body!.password as string)
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id))
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id))
    await tx.delete(schema.pendingSignIns).where(eq(schema.pendingSignIns.userId, user.id))
  })
  // Without a current password to check, setting one proves nothing new, so it doesn't count as a fresh sign-in
  await startSession(c, user.id, user.passwordHash ? undefined : (c.get('session')?.createdAt ?? undefined))
  return c.body(null, 204)
})

// MCP clients that still hold a live token for this person, with the workspaces they publish to
settings.get('/agents', async (c) => {
  const user = c.get('user')!
  const rows = await db
    .select({
      clientId: schema.oauthTokens.clientId,
      clientName: schema.oauthClients.name,
      organizationId: schema.oauthTokens.organizationId,
      organizationName: schema.organizations.name,
      lastUsedAt: max(schema.oauthTokens.lastUsedAt),
      connectedAt: max(schema.oauthTokens.createdAt),
    })
    .from(schema.oauthTokens)
    .innerJoin(schema.oauthClients, eq(schema.oauthTokens.clientId, schema.oauthClients.id))
    .leftJoin(schema.organizations, eq(schema.oauthTokens.organizationId, schema.organizations.id))
    .where(and(eq(schema.oauthTokens.userId, user.id), gt(schema.oauthTokens.expiresAt, new Date())))
    .groupBy(schema.oauthTokens.clientId, schema.oauthClients.name, schema.oauthTokens.organizationId, schema.organizations.name)

  type Agent = { clientId: string; name: string; workspaces: string[]; lastUsedAt: string | null; connectedAt: string }
  const byClient = new Map<string, Agent>()
  for (const r of rows) {
    const workspace = r.organizationName ?? 'Personal'
    const last = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null
    const connected = new Date(r.connectedAt!).toISOString()
    const agent = byClient.get(r.clientId)
    if (!agent) {
      byClient.set(r.clientId, { clientId: r.clientId, name: r.clientName, workspaces: [workspace], lastUsedAt: last, connectedAt: connected })
      continue
    }
    agent.workspaces.push(workspace)
    if (last && (!agent.lastUsedAt || last > agent.lastUsedAt)) agent.lastUsedAt = last
    if (connected > agent.connectedAt) agent.connectedAt = connected
  }
  const agents = [...byClient.values()].sort((a, b) => (b.lastUsedAt ?? b.connectedAt).localeCompare(a.lastUsedAt ?? a.connectedAt))
  return c.json(agents)
})

settings.delete('/agents/:clientId', async (c) => {
  const user = c.get('user')!
  const clientId = c.req.param('clientId')
  await db.transaction(async (tx) => {
    await tx.delete(schema.oauthTokens).where(and(eq(schema.oauthTokens.userId, user.id), eq(schema.oauthTokens.clientId, clientId)))
    await tx.delete(schema.oauthGrants).where(and(eq(schema.oauthGrants.userId, user.id), eq(schema.oauthGrants.clientId, clientId)))
  })
  return c.body(null, 204)
})

// Access tokens for CI and scripts (src/tokens.ts). Only the web app's session can manage them:
// a token can't make or list tokens, since these routes never read a bearer token.
settings.get('/access-tokens', async (c) => c.json(await tokensOf(c.get('user')!.id)))

// { name, organizationId (null for the personal workspace), expiresInDays (7, 30, 90, 365 or null for none; 90 if left out) }.
// The token is in this response only.
settings.post('/access-tokens', async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; organizationId?: unknown; expiresInDays?: unknown } | null
  const name = checkTokenName(body?.name)
  if ('error' in name) return c.json({ error: name.error, field: 'name' }, 400)
  const expiry = checkExpiry(body?.expiresInDays)
  if ('error' in expiry) return c.json({ error: expiry.error, field: 'expiresInDays' }, 400)
  const organizationId = body?.organizationId ?? null
  if (organizationId !== null) {
    const [member] =
      typeof organizationId === 'string' && UUID_RE.test(organizationId)
        ? await db
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.userId, user.id), eq(schema.memberships.organizationId, organizationId)))
        : []
    if (!member) return c.json({ error: 'You are not a member of that organization.', field: 'organizationId' }, 400)
    if (user.blockedOrgs.includes(organizationId as string))
      return c.json({ ...(await twoFactorRequiredError(organizationId as string)), field: 'organizationId' }, 403)
  }
  const busy = await limitRequest(c, 'access-token', user.id, 'You have created a lot of access tokens in a short time.')
  if (busy) return busy
  const { token, row } = await createToken({ userId: user.id, organizationId: organizationId as string | null, name: name.name, expiresAt: expiry.expiresAt })
  auditToken('access_token.created', row, user)
  track({ event: 'agent_connected', userId: user.id, detail: 'access_token' })
  return c.json({ token, accessToken: await describeToken(row.id) }, 201)
})

settings.delete('/access-tokens/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id) || !(await revokeToken(id, { userId: c.get('user')!.id }, c.get('user')!)))
    return c.json({ error: 'That access token was already revoked.' }, 404)
  return c.body(null, 204)
})

// Organizations this person owns alone. Those with other people in them block deleting the account;
// those with nobody else are deleted along with it.
export async function ownedAlone(userId: string) {
  const owned = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.role, 'owner')))

  const blocked: { id: string; name: string }[] = []
  const empty: string[] = []
  for (const org of owned) {
    const others = await db
      .select({ role: schema.memberships.role, n: count() })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, org.id), ne(schema.memberships.userId, userId)))
      .groupBy(schema.memberships.role)
    if (others.some((o) => o.role === 'owner')) continue
    if (others.length) blocked.push(org)
    else empty.push(org.id)
  }
  return { blocked, empty }
}

const ROLE_RANK = sql`case ${schema.memberships.role} when 'owner' then 0 when 'admin' then 1 else 2 end`

// Who takes over pages someone published in an organization when they delete their account:
// the longest-standing other owner, or else the longest-standing admin, or else member.
// While the account can be deleted, every organization with other people in it has another owner,
// so in practice it is always an owner; the fallbacks cover anything unexpected.
async function successorIn(organizationId: string, userId: string) {
  const [row] = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(eq(schema.memberships.organizationId, organizationId), ne(schema.memberships.userId, userId)))
    .orderBy(ROLE_RANK, asc(schema.memberships.createdAt))
    .limit(1)
  return row ?? null
}

type Transfer = { organizationId: string; organization: string; to: { id: string; email: string; name: string | null }; pageIds: string[] }

// What deleting the account does: organizations it is blocked by or deletes, pages that move to
// someone else in their organization, and pages deleted with the account
async function deletionPlan(userId: string) {
  const { blocked, empty } = await ownedAlone(userId)
  const pages = await db
    .select({ id: schema.artifacts.id, organizationId: schema.artifacts.organizationId, organization: schema.organizations.name })
    .from(schema.artifacts)
    .leftJoin(schema.organizations, eq(schema.artifacts.organizationId, schema.organizations.id))
    .where(eq(schema.artifacts.ownerId, userId))

  const transfers = new Map<string, Transfer | null>()
  let deletedPages = 0
  for (const page of pages) {
    // Personal pages, and pages in organizations deleted along with the account
    if (!page.organizationId || empty.includes(page.organizationId)) {
      deletedPages += 1
      continue
    }
    if (!transfers.has(page.organizationId)) {
      const to = await successorIn(page.organizationId, userId)
      transfers.set(page.organizationId, to ? { organizationId: page.organizationId, organization: page.organization!, to, pageIds: [] } : null)
    }
    const transfer = transfers.get(page.organizationId)
    if (transfer) transfer.pageIds.push(page.id)
    else deletedPages += 1
  }
  return { blocked, empty, transfers: [...transfers.values()].filter((t): t is Transfer => t !== null), deletedPages }
}

// Removes the account once nothing blocks it (see ownedAlone): pages in organizations with other
// people move to a successor, the rest goes with the account. Also used by the admin area.
export async function deleteAccountData(user: { id: string; email: string }) {
  const { empty, transfers } = await deletionPlan(user.id)
  const exports = await exportsOf(user.id)
  await db.transaction(async (tx) => {
    // Pages in organizations with other people stay, with their history, under a new owner
    for (const t of transfers) {
      await tx.update(schema.artifacts).set({ ownerId: t.to.id }).where(inArray(schema.artifacts.id, t.pageIds))
      // The new owner no longer needs to be on the page's share list
      await tx.delete(schema.artifactShares).where(and(inArray(schema.artifactShares.artifactId, t.pageIds), eq(schema.artifactShares.email, t.to.email)))
    }
    // Organizations with nobody else in them go too
    if (empty.length) await tx.delete(schema.organizations).where(inArray(schema.organizations.id, empty))
    await tx.delete(schema.artifactShares).where(eq(schema.artifactShares.email, user.email))
    await tx.delete(schema.invitations).where(eq(schema.invitations.email, user.email))
    await tx.delete(schema.emailTokens).where(eq(schema.emailTokens.email, user.email))
    // Sessions, memberships, agent and access tokens and the remaining (personal) pages cascade from the user.
    // Invitations and shares they sent, and versions they published, keep working without them.
    await tx.delete(schema.users).where(eq(schema.users.id, user.id))
  })
  // Their data exports' rows went with the account; the zips go now rather than at the next sweep
  await deleteExportFiles(exports)
  forgetAccounts()
}

// What deleting the account would do, so the page can explain it before anyone types their email
settings.get('/deletion', async (c) => {
  const { blocked, empty, transfers, deletedPages } = await deletionPlan(c.get('user')!.id)
  const names = empty.length
    ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, empty))
    : []
  return c.json({
    blockedBy: blocked,
    deletesOrganizations: names.map((n) => n.name),
    pages: {
      deleted: deletedPages,
      transferred: transfers.reduce((n, t) => n + t.pageIds.length, 0),
    },
    transfers: transfers.map((t) => ({ organization: t.organization, to: t.to.name ?? t.to.email, pages: t.pageIds.length })),
  })
})

settings.delete('/', async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { confirmEmail?: unknown } | null
  const typed = typeof body?.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : ''
  if (typed !== user.email) return c.json({ error: 'Type your email address exactly to confirm.', field: 'confirmEmail' }, 400)

  const { blocked } = await deletionPlan(user.id)
  if (blocked.length) {
    const names = blocked.map((o) => o.name).join(', ')
    return c.json(
      {
        error: `You are the only owner of ${names}. Make someone else an owner, or remove the other people, before you delete your account.`,
        code: 'last_owner',
        organizations: blocked,
      },
      409,
    )
  }

  if (await isLastAdmin(user)) return c.json(lastAdminError, 409)
  await deleteAccountData(user)
  deleteCookie(c, 'session', { path: '/' })
  return c.body(null, 204)
})
