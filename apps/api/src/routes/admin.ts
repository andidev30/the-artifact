import { and, count, countDistinct, desc, eq, gt, ilike, inArray, isNotNull, max, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import type { User } from '../db/schema.js'
import { env } from '../env.js'
import {
  activeAdminCount,
  adminCondition,
  adminFromEnvironment,
  instanceSettings,
  isInstanceAdmin,
  lockAdmins,
  parseSettings,
  resetSettings,
  revokeAccess,
  saveSettings,
} from '../instance.js'
import { deleteAccountData, ownedAlone } from './settings.js'

// The instance admin area, mounted at /api/admin. Only instance admins get past requireAdmin.
export const admin = new Hono<AuthEnv>()

const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!isInstanceAdmin(user)) return c.json({ error: 'Only instance admins can open this.', code: 'not_admin' }, 403)
  await next()
})
admin.use(requireAdmin)

const PAGE_SIZE = 50

// Escapes LIKE wildcards so a search for "a_b" matches literally
const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

admin.get('/overview', async (c) => {
  const [users] = await db
    .select({
      total: count(),
      suspended: count(schema.users.suspendedAt),
      newThisWeek: sql<number>`count(*) filter (where ${schema.users.createdAt} > now() - interval '7 days')`.mapWith(Number),
      activeThisWeek: sql<number>`count(*) filter (where ${schema.users.lastSeenAt} > now() - interval '7 days')`.mapWith(Number),
    })
    .from(schema.users)
  const [orgs] = await db.select({ total: count() }).from(schema.organizations)
  const [pages] = await db.select({ total: count() }).from(schema.artifacts)
  const [agents] = await db
    .select({ people: countDistinct(schema.oauthTokens.userId) })
    .from(schema.oauthTokens)
    .where(gt(schema.oauthTokens.expiresAt, new Date()))
  const settings = await instanceSettings()
  return c.json({
    users: users.total,
    admins: await activeAdminCount(),
    suspended: users.suspended,
    newThisWeek: users.newThisWeek,
    activeThisWeek: users.activeThisWeek,
    organizations: orgs.total,
    pages: pages.total,
    peopleWithAgents: agents.people,
    signupPolicy: settings.signupPolicy,
    allowedDomains: settings.allowedDomains,
  })
})

type UserRow = Pick<User, 'id' | 'email' | 'name' | 'avatarUrl' | 'isAdmin' | 'suspendedAt' | 'lastSeenAt' | 'createdAt'>

// Adds organizations, page counts and agent activity to a page of users
async function describeUsers(rows: UserRow[], viewerId: string) {
  const ids = rows.map((r) => r.id)
  if (!ids.length) return []
  const [orgs, pages, tokens] = await Promise.all([
    db
      .select({
        userId: schema.memberships.userId,
        id: schema.organizations.id,
        name: schema.organizations.name,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
      .where(inArray(schema.memberships.userId, ids))
      .orderBy(schema.memberships.createdAt),
    db
      .select({ userId: schema.artifacts.ownerId, n: count() })
      .from(schema.artifacts)
      .where(inArray(schema.artifacts.ownerId, ids))
      .groupBy(schema.artifacts.ownerId),
    db
      .select({ userId: schema.oauthTokens.userId, lastUsedAt: max(schema.oauthTokens.lastUsedAt) })
      .from(schema.oauthTokens)
      .where(inArray(schema.oauthTokens.userId, ids))
      .groupBy(schema.oauthTokens.userId),
  ])
  return rows.map((u) => {
    const agentSeen = tokens.find((t) => t.userId === u.id)?.lastUsedAt
    const seen = [u.lastSeenAt, agentSeen ? new Date(agentSeen) : null].filter((d): d is Date => Boolean(d))
    const fromEnvironment = adminFromEnvironment(u.email)
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: seen.length ? new Date(Math.max(...seen.map((d) => d.getTime()))).toISOString() : null,
      isAdmin: u.isAdmin || fromEnvironment,
      // ADMIN_EMAILS admins can't be demoted here; the list lives in the server's environment
      adminFromEnvironment: fromEnvironment,
      suspended: Boolean(u.suspendedAt),
      suspendedAt: u.suspendedAt?.toISOString() ?? null,
      organizations: orgs.filter((o) => o.userId === u.id).map(({ id, name, role }) => ({ id, name, role })),
      pageCount: pages.find((p) => p.userId === u.id)?.n ?? 0,
      isYou: u.id === viewerId,
    }
  })
}

const userColumns = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
  avatarUrl: schema.users.avatarUrl,
  isAdmin: schema.users.isAdmin,
  suspendedAt: schema.users.suspendedAt,
  lastSeenAt: schema.users.lastSeenAt,
  createdAt: schema.users.createdAt,
}

// ?q= searches email and name; ?filter=admins|suspended narrows; ?offset= pages through
admin.get('/users', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const filter = c.req.query('filter')
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const where = and(
    q ? or(ilike(schema.users.email, likeTerm(q)), ilike(schema.users.name, likeTerm(q))) : undefined,
    filter === 'admins' ? adminCondition() : filter === 'suspended' ? isNotNull(schema.users.suspendedAt) : undefined,
  )
  const [{ total }] = await db.select({ total: count() }).from(schema.users).where(where)
  const rows = await db
    .select(userColumns)
    .from(schema.users)
    .where(where)
    .orderBy(desc(schema.users.createdAt), schema.users.id)
    .limit(PAGE_SIZE)
    .offset(offset)
  return c.json({ users: await describeUsers(rows, c.get('user')!.id), total, offset, pageSize: PAGE_SIZE })
})

async function findUser(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id))
  return row ?? null
}

class Conflict extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

// { admin?: boolean, suspended?: boolean }
admin.patch('/users/:id', async (c) => {
  const actor = c.get('user')!
  if (!(await findUser(c.req.param('id')))) return c.json({ error: 'This person no longer has an account.' }, 404)
  const body = (await c.req.json().catch(() => null)) as { admin?: unknown; suspended?: unknown } | null
  const makeAdmin = typeof body?.admin === 'boolean' ? body.admin : undefined
  const suspend = typeof body?.suspended === 'boolean' ? body.suspended : undefined
  if (makeAdmin === undefined && suspend === undefined) return c.json({ error: 'Send admin or suspended.' }, 400)

  try {
    await db.transaction(async (tx) => {
      // Admin changes one at a time, so two admins can't demote each other into having none
      await lockAdmins(tx)
      // Checked again under the lock: another admin may have just removed this one
      const [self] = await tx.select().from(schema.users).where(eq(schema.users.id, actor.id))
      if (!self || !isInstanceAdmin(self)) throw new Conflict('Only instance admins can open this.', 'not_admin')
      const [target] = await tx.select().from(schema.users).where(eq(schema.users.id, c.req.param('id'))).for('update')
      if (!target) throw new Conflict('This person no longer has an account.', 'not_found')
      const set: Partial<User> = {}

      if (makeAdmin === false && (target.isAdmin || adminFromEnvironment(target.email))) {
        if (adminFromEnvironment(target.email)) {
          throw new Conflict(`${target.email} is an admin through ADMIN_EMAILS. Remove it there to take admin access away.`, 'admin_from_environment')
        }
        if (isInstanceAdmin(target) && (await activeAdminCount(tx)) <= 1) {
          throw new Conflict('This is the only admin. Make someone else an admin first.', 'last_admin')
        }
      }
      if (makeAdmin !== undefined) set.isAdmin = makeAdmin

      if (suspend === true && !target.suspendedAt) {
        if (target.id === actor.id) throw new Conflict('You can’t suspend yourself.', 'self')
        if (isInstanceAdmin(target) && (await activeAdminCount(tx)) <= 1) {
          throw new Conflict('This is the only admin. Make someone else an admin first.', 'last_admin')
        }
        set.suspendedAt = new Date()
        await revokeAccess(tx, target)
      }
      if (suspend === false) set.suspendedAt = null

      await tx.update(schema.users).set(set).where(eq(schema.users.id, target.id))
    })
  } catch (err) {
    if (err instanceof Conflict) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : err.code === 'not_admin' ? 403 : 409)
    throw err
  }

  const [row] = await db.select(userColumns).from(schema.users).where(eq(schema.users.id, c.req.param('id')))
  const [described] = await describeUsers([row], actor.id)
  return c.json(described)
})

// What deleting this person would do, so the page can explain it first
admin.get('/users/:id/deletion', async (c) => {
  const target = await findUser(c.req.param('id'))
  if (!target) return c.json({ error: 'This person no longer has an account.' }, 404)
  const { blocked, empty } = await ownedAlone(target.id)
  const names = empty.length ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, empty)) : []
  const [pages] = await db.select({ n: count() }).from(schema.artifacts).where(eq(schema.artifacts.ownerId, target.id))
  return c.json({ blockedBy: blocked, deletesOrganizations: names.map((n) => n.name), pageCount: pages.n })
})

// Same rules as deleting your own account in Settings; { confirmEmail } must match the account
admin.delete('/users/:id', async (c) => {
  const actor = c.get('user')!
  const target = await findUser(c.req.param('id'))
  if (!target) return c.json({ error: 'This person no longer has an account.' }, 404)
  if (target.id === actor.id) return c.json({ error: 'Delete your own account from Settings.', code: 'self' }, 409)
  const body = (await c.req.json().catch(() => null)) as { confirmEmail?: unknown } | null
  const typed = typeof body?.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : ''
  if (typed !== target.email) return c.json({ error: 'Type their email address exactly to confirm.', field: 'confirmEmail' }, 400)
  if (adminFromEnvironment(target.email)) {
    return c.json({ error: `${target.email} is an admin through ADMIN_EMAILS. Remove it there first.`, code: 'admin_from_environment' }, 409)
  }

  const { blocked } = await ownedAlone(target.id)
  if (blocked.length) {
    const names = blocked.map((o) => o.name).join(', ')
    return c.json(
      {
        error: `${target.email} is the only owner of ${names}. Make someone else an owner there first, or delete the organization.`,
        code: 'last_owner',
        organizations: blocked,
      },
      409,
    )
  }
  // The actor is an active admin, so removing someone else never leaves the instance without one
  await deleteAccountData(target)
  return c.body(null, 204)
})

admin.get('/organizations', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const where = q ? or(ilike(schema.organizations.name, likeTerm(q)), ilike(schema.organizations.slug, likeTerm(q))) : undefined
  const [{ total }] = await db.select({ total: count() }).from(schema.organizations).where(where)
  const orgs = await db
    .select()
    .from(schema.organizations)
    .where(where)
    .orderBy(desc(schema.organizations.createdAt), schema.organizations.id)
    .limit(PAGE_SIZE)
    .offset(offset)
  const ids = orgs.map((o) => o.id)
  const [members, pages, owners] = ids.length
    ? await Promise.all([
        db
          .select({ id: schema.memberships.organizationId, n: count() })
          .from(schema.memberships)
          .where(inArray(schema.memberships.organizationId, ids))
          .groupBy(schema.memberships.organizationId),
        db
          .select({ id: schema.artifacts.organizationId, n: count() })
          .from(schema.artifacts)
          .where(inArray(schema.artifacts.organizationId, ids))
          .groupBy(schema.artifacts.organizationId),
        db
          .select({ orgId: schema.memberships.organizationId, id: schema.users.id, email: schema.users.email, name: schema.users.name })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
          .where(and(inArray(schema.memberships.organizationId, ids), eq(schema.memberships.role, 'owner')))
          .orderBy(schema.memberships.createdAt),
      ])
    : [[], [], []]
  return c.json({
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt.toISOString(),
      memberCount: members.find((m) => m.id === o.id)?.n ?? 0,
      pageCount: pages.find((p) => p.id === o.id)?.n ?? 0,
      owners: owners.filter((w) => w.orgId === o.id).map(({ id, email, name }) => ({ id, email, name })),
    })),
    total,
    offset,
    pageSize: PAGE_SIZE,
  })
})

// Deletes the organization with its memberships, invitations and pages. { confirmSlug } must match.
admin.delete('/organizations/:id', async (c) => {
  const id = c.req.param('id')
  const [org] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select().from(schema.organizations).where(eq(schema.organizations.id, id)) : []
  if (!org) return c.json({ error: 'This organization no longer exists.' }, 404)
  const body = (await c.req.json().catch(() => null)) as { confirmSlug?: unknown } | null
  const typed = typeof body?.confirmSlug === 'string' ? body.confirmSlug.trim().toLowerCase() : ''
  if (typed !== org.slug) return c.json({ error: 'Type the organization’s address exactly to confirm.', field: 'confirmSlug' }, 400)
  await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id))
  return c.body(null, 204)
})

function settingsResponse(s: Awaited<ReturnType<typeof instanceSettings>>) {
  return {
    ...s,
    environment: { allowedEmailDomains: env.allowedEmailDomains, adminEmails: env.adminEmails },
  }
}

admin.get('/settings', async (c) => c.json(settingsResponse(await instanceSettings())))

admin.put('/settings', async (c) => {
  const parsed = parseSettings(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  await saveSettings(parsed.value, c.get('user')!.id)
  return c.json(settingsResponse(await instanceSettings()))
})

// Forget the saved settings and go back to ALLOWED_EMAIL_DOMAINS
admin.delete('/settings', async (c) => {
  await resetSettings()
  return c.json(settingsResponse(await instanceSettings()))
})
