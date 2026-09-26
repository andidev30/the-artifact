import { and, count, eq, gt, inArray, max, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie } from 'hono/cookie'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { isLastAdmin, lastAdminError } from '../instance.js'

// Account settings, mounted at /api/me next to GET /api/me
export const settings = new Hono<AuthEnv>()
settings.use(requireUser)

settings.patch('/', async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 80) return c.json({ error: 'Use 1 to 80 characters for your name.', field: 'name' }, 400)
  await db.update(schema.users).set({ name }).where(eq(schema.users.id, user.id))
  return c.json({ name })
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

// Removes the account once ownedAlone() found nothing blocking; also used by the admin area
export async function deleteAccountData(user: { id: string; email: string }, emptyOrganizations: string[]) {
  await db.transaction(async (tx) => {
    // Organizations with nobody else in them go too
    if (emptyOrganizations.length) await tx.delete(schema.organizations).where(inArray(schema.organizations.id, emptyOrganizations))
    await tx.delete(schema.artifactShares).where(eq(schema.artifactShares.email, user.email))
    await tx.delete(schema.invitations).where(eq(schema.invitations.email, user.email))
    await tx.delete(schema.emailTokens).where(eq(schema.emailTokens.email, user.email))
    // Sessions, memberships, agent tokens and pages cascade from the user
    await tx.delete(schema.users).where(eq(schema.users.id, user.id))
  })
}

// What deleting the account would do, so the page can explain it before anyone types their email
settings.get('/deletion', async (c) => {
  const { blocked, empty } = await ownedAlone(c.get('user')!.id)
  const names = empty.length
    ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, empty))
    : []
  return c.json({ blockedBy: blocked, deletesOrganizations: names.map((n) => n.name) })
})

settings.delete('/', async (c) => {
  const user = c.get('user')!
  const body = (await c.req.json().catch(() => null)) as { confirmEmail?: unknown } | null
  const typed = typeof body?.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : ''
  if (typed !== user.email) return c.json({ error: 'Type your email address exactly to confirm.', field: 'confirmEmail' }, 400)

  const { blocked, empty } = await ownedAlone(user.id)
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
  await deleteAccountData(user, empty)
  deleteCookie(c, 'session', { path: '/' })
  return c.body(null, 204)
})
