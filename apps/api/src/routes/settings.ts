import { and, asc, count, eq, gt, inArray, max, ne, sql } from 'drizzle-orm'
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
  await db.transaction(async (tx) => {
    // Pages in organizations with other people stay, with their history, under a new owner
    for (const t of transfers) {
      await tx.update(schema.artifacts).set({ ownerId: t.to.id }).where(inArray(schema.artifacts.id, t.pageIds))
      // The new owner no longer needs to be on the page's share list
      await tx
        .delete(schema.artifactShares)
        .where(and(inArray(schema.artifactShares.artifactId, t.pageIds), eq(schema.artifactShares.email, t.to.email)))
    }
    // Organizations with nobody else in them go too
    if (empty.length) await tx.delete(schema.organizations).where(inArray(schema.organizations.id, empty))
    await tx.delete(schema.artifactShares).where(eq(schema.artifactShares.email, user.email))
    await tx.delete(schema.invitations).where(eq(schema.invitations.email, user.email))
    await tx.delete(schema.emailTokens).where(eq(schema.emailTokens.email, user.email))
    // Sessions, memberships, agent tokens and the remaining (personal) pages cascade from the user.
    // Invitations and shares they sent, and versions they published, keep working without them.
    await tx.delete(schema.users).where(eq(schema.users.id, user.id))
  })
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
