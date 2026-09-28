import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { twoFactorRequiredError } from '../auth/factors.js'
import { hashToken, randomToken, requireUser, type AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { auditAgent } from './server.js'

// Backs the consent page at /authorize, where a signed-in person lets an MCP client act for them
export const consent = new Hono<AuthEnv>()
consent.use(requireUser)

async function openGrant(id: string) {
  const [row] = await db
    .select({ grant: schema.oauthGrants, client: schema.oauthClients })
    .from(schema.oauthGrants)
    .innerJoin(schema.oauthClients, eq(schema.oauthGrants.clientId, schema.oauthClients.id))
    .where(and(eq(schema.oauthGrants.id, id), isNull(schema.oauthGrants.code)))
  if (!row || row.grant.expiresAt.getTime() < Date.now()) return null
  return row
}

// blocked: the organization requires a second factor this person hasn't set up, so agents can't be connected to it yet
async function workspacesFor(userId: string, blockedOrgs: readonly string[]) {
  const orgs = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(schema.memberships.createdAt)
  return [...orgs.map((o) => ({ ...o, blocked: blockedOrgs.includes(o.id) })), { id: null, name: 'Personal', blocked: false }]
}

consent.get('/:id', async (c) => {
  const row = await openGrant(c.req.param('id'))
  if (!row) return c.json({ error: 'This request has expired. Start the connection again from your agent.' }, 404)
  return c.json({
    clientName: row.client.name,
    redirectHost: new URL(row.grant.redirectUri).host || new URL(row.grant.redirectUri).protocol,
    workspaces: await workspacesFor(c.get('user')!.id, c.get('user')!.blockedOrgs),
  })
})

consent.post('/:id/approve', async (c) => {
  const user = c.get('user')!
  const row = await openGrant(c.req.param('id'))
  if (!row) return c.json({ error: 'This request has expired. Start the connection again from your agent.' }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { organizationId?: string | null }
  const organizationId = body.organizationId ?? null
  if (organizationId) {
    const [member] = await db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, user.id), eq(schema.memberships.organizationId, organizationId)))
    if (!member) return c.json({ error: 'You are not a member of that organization.' }, 403)
    if (user.blockedOrgs.includes(organizationId)) return c.json(await twoFactorRequiredError(organizationId), 403)
  }

  const code = randomToken()
  await db
    .update(schema.oauthGrants)
    .set({ userId: user.id, organizationId, code: hashToken(code) })
    .where(eq(schema.oauthGrants.id, row.grant.id))
  await auditAgent('agent.connected', row.client.id, user.id, [organizationId])

  const back = new URL(row.grant.redirectUri)
  back.searchParams.set('code', code)
  if (row.grant.state) back.searchParams.set('state', row.grant.state)
  return c.json({ redirect: back.toString() })
})

consent.post('/:id/deny', async (c) => {
  const row = await openGrant(c.req.param('id'))
  if (!row) return c.json({ error: 'This request has expired.' }, 404)
  await db.delete(schema.oauthGrants).where(eq(schema.oauthGrants.id, row.grant.id))
  const back = new URL(row.grant.redirectUri)
  back.searchParams.set('error', 'access_denied')
  if (row.grant.state) back.searchParams.set('state', row.grant.state)
  return c.json({ redirect: back.toString() })
})
