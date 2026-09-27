import { and, asc, count, eq, gt, notExists } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { hashPassword, passwordProblem } from '../auth/password.js'
import { hashToken, randomToken, requireUser, startSession, type AuthEnv } from '../auth/session.js'
import { createPasswordAccount, userExists } from '../auth/users.js'
import { db, schema } from '../db/index.js'
import type { InviteRole, Role, User } from '../db/schema.js'
import { env, mailEnabled } from '../env.js'
import { sendInvitation } from '../mail.js'
import { EMAIL_RE } from '../validation.js'

const DAY = 24 * 60 * 60 * 1000
const INVITE_DAYS = 7
const ROLES = new Set<Role>(['owner', 'admin', 'member'])
const INVITE_ROLES = new Set<InviteRole>(['admin', 'member'])

// Owners manage everyone; admins manage admins and members; members manage nobody
export function canManage(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true
  if (actor === 'admin') return target !== 'owner'
  return false
}

function inviteUrl(token: string) {
  return new URL(`/invite/${token}`, env.appUrl).toString()
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Locks the organization's owner rows so two requests can't remove the last two owners at once
async function ownerCount(tx: Tx, organizationId: string): Promise<number> {
  const rows = await tx
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.role, 'owner')))
    .for('update')
  return rows.length
}

class RuleError extends Error {
  status: 400 | 403 | 404 | 409
  constructor(message: string, status: 400 | 403 | 404 | 409 = 403) {
    super(message)
    this.status = status
  }
}

async function membershipOf(organizationId: string, userId: string) {
  const [row] = await db
    .select({ role: schema.memberships.role, org: schema.organizations })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(and(eq(schema.memberships.organizationId, organizationId), eq(schema.memberships.userId, userId)))
  return row ?? null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The caller's membership in :orgId; organizations they don't belong to look missing
async function actor(c: Context<AuthEnv>) {
  const orgId = c.req.param('orgId') ?? ''
  if (!UUID_RE.test(orgId)) return null
  return membershipOf(orgId, c.get('user')!.id)
}

async function listMembers(organizationId: string) {
  return db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      role: schema.memberships.role,
      joinedAt: schema.memberships.createdAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(asc(schema.memberships.createdAt))
}

async function listInvitations(organizationId: string) {
  const rows = await db
    .select({
      id: schema.invitations.id,
      email: schema.invitations.email,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
      createdAt: schema.invitations.createdAt,
      invitedBy: schema.users.name,
      invitedByEmail: schema.users.email,
    })
    .from(schema.invitations)
    .leftJoin(schema.users, eq(schema.invitations.invitedBy, schema.users.id))
    .where(eq(schema.invitations.organizationId, organizationId))
    .orderBy(asc(schema.invitations.createdAt))
  return rows.map(({ invitedByEmail, ...r }) => ({
    ...r,
    invitedBy: r.invitedBy ?? invitedByEmail,
    expired: r.expiresAt.getTime() < Date.now(),
  }))
}

async function details(organizationId: string, role: Role) {
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, organizationId))
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role,
    members: await listMembers(organizationId),
    // Only people who can manage members see who is invited
    invitations: role === 'member' ? [] : await listInvitations(organizationId),
  }
}

function fail(c: Context<AuthEnv>, err: unknown) {
  if (err instanceof RuleError) return c.json({ error: err.message }, err.status)
  throw err
}

// Mounted at /api/organizations/:orgId
export const members = new Hono<AuthEnv>()
members.use(requireUser)

members.get('/', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  return c.json(await details(me.org.id, me.role))
})

members.patch('/', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can rename the organization.' }, 403)
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name.length < 2 || name.length > 60) return c.json({ error: 'Use 2 to 60 characters for the name.', field: 'name' }, 400)
  await db.update(schema.organizations).set({ name }).where(eq(schema.organizations.id, me.org.id))
  return c.json(await details(me.org.id, me.role))
})

members.post('/invitations', async (c) => {
  const user = c.get('user')!
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can invite people.' }, 403)

  const body = (await c.req.json().catch(() => null)) as { email?: unknown; role?: unknown } | null
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const role = body?.role as InviteRole
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address.', field: 'email' }, 400)
  if (!INVITE_ROLES.has(role)) return c.json({ error: 'Invite people as an admin or a member.', field: 'role' }, 400)

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.users.email, email)))
  if (existing) return c.json({ error: `${email} is already in ${me.org.name}.`, field: 'email' }, 409)

  // Inviting the same address again replaces the old link and restarts the 7 days
  const token = randomToken()
  const expiresAt = new Date(Date.now() + INVITE_DAYS * DAY)
  await db
    .insert(schema.invitations)
    .values({ organizationId: me.org.id, email, role, tokenHash: hashToken(token), invitedBy: user.id, expiresAt })
    .onConflictDoUpdate({
      target: [schema.invitations.organizationId, schema.invitations.email],
      set: { role, tokenHash: hashToken(token), invitedBy: user.id, expiresAt, createdAt: new Date() },
    })

  const link = inviteUrl(token)
  // Without email, the person who invited passes the link on
  let emailed = mailEnabled()
  if (emailed) {
    try {
      await sendInvitation(email, { from: user.name ?? user.email, organization: me.org.name, role, link, expiresInDays: INVITE_DAYS })
    } catch (err) {
      console.error('Sending invitation email failed', err)
      emailed = false
    }
  }
  // The link is only returned when the email could not be sent, so it can be passed on another way
  return c.json({ emailed, link: emailed ? undefined : link, organization: await details(me.org.id, me.role) }, 201)
})

members.delete('/invitations/:id', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can revoke invitations.' }, 403)
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)
  const deleted = await db
    .delete(schema.invitations)
    .where(and(eq(schema.invitations.id, id), eq(schema.invitations.organizationId, me.org.id)))
    .returning({ id: schema.invitations.id })
  if (!deleted.length) return c.json({ error: 'That invitation was already accepted or revoked.' }, 404)
  return c.json(await details(me.org.id, me.role))
})

members.patch('/members/:userId', async (c) => {
  const user = c.get('user')!
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  const targetId = c.req.param('userId')
  const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null
  const role = body?.role as Role
  if (!ROLES.has(role)) return c.json({ error: 'Choose owner, admin or member.' }, 400)

  try {
    await db.transaction(async (tx) => {
      const owners = await ownerCount(tx, me.org.id)
      const [target] = UUID_RE.test(targetId)
        ? await tx
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
        : []
      if (!target) throw new RuleError('That person is not in this organization.', 404)
      if (target.role === role) return
      if (!canManage(me.role, target.role) || !canManage(me.role, role)) {
        throw new RuleError(
          me.role === 'member'
            ? 'Only owners and admins can change roles.'
            : 'Only owners can change an owner or make someone an owner.',
        )
      }
      if (target.role === 'owner' && owners <= 1) {
        throw new RuleError(
          targetId === user.id
            ? 'You are the only owner. Make someone else an owner before changing your role.'
            : 'An organization needs at least one owner.',
          409,
        )
      }
      await tx
        .update(schema.memberships)
        .set({ role })
        .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
    })
  } catch (err) {
    return fail(c, err)
  }
  const after = await membershipOf(me.org.id, user.id)
  return c.json(await details(me.org.id, after?.role ?? me.role))
})

// Removing yourself is leaving; anyone can leave, except the last owner
members.delete('/members/:userId', async (c) => {
  const user = c.get('user')!
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  const targetId = c.req.param('userId')
  const leaving = targetId === user.id

  try {
    await db.transaction(async (tx) => {
      const owners = await ownerCount(tx, me.org.id)
      const [target] = UUID_RE.test(targetId)
        ? await tx
            .select({ role: schema.memberships.role })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
        : []
      if (!target) throw new RuleError('That person is not in this organization.', 404)
      if (!leaving && !canManage(me.role, target.role)) {
        throw new RuleError(me.role === 'member' ? 'Only owners and admins can remove people.' : 'Only owners can remove an owner.')
      }
      if (target.role === 'owner' && owners <= 1) {
        throw new RuleError(
          leaving
            ? 'You are the only owner. Make someone else an owner before you leave.'
            : 'An organization needs at least one owner.',
          409,
        )
      }
      await tx
        .delete(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
      // Agents connected to this organization stop publishing there
      await tx
        .delete(schema.oauthTokens)
        .where(and(eq(schema.oauthTokens.organizationId, me.org.id), eq(schema.oauthTokens.userId, targetId)))
    })
  } catch (err) {
    return fail(c, err)
  }
  if (leaving) return c.body(null, 204)
  return c.json(await details(me.org.id, me.role))
})

// Opening an invitation link: public so the page can say what it is before anyone signs in
export const invitations = new Hono<AuthEnv>()

async function findInvitation(token: string) {
  const [row] = await db
    .select({ invitation: schema.invitations, org: schema.organizations, inviterName: schema.users.name, inviterEmail: schema.users.email })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.invitations.organizationId, schema.organizations.id))
    .leftJoin(schema.users, eq(schema.invitations.invitedBy, schema.users.id))
    .where(eq(schema.invitations.tokenHash, hashToken(token)))
  return row ?? null
}

invitations.get('/:token', async (c) => {
  const user = c.get('user')
  const row = await findInvitation(c.req.param('token'))
  if (!row) return c.json({ error: 'This invitation is not valid. It may have been revoked or already accepted.' }, 404)
  const [member] = user ? await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.organizationId, row.org.id), eq(schema.memberships.userId, user.id))) : []
  const [{ value: memberCount }] = await db
    .select({ value: count() })
    .from(schema.memberships)
    .where(eq(schema.memberships.organizationId, row.org.id))
  return c.json({
    organization: { id: row.org.id, name: row.org.name, slug: row.org.slug, memberCount },
    email: row.invitation.email,
    role: row.invitation.role,
    invitedBy: row.inviterName ?? row.inviterEmail,
    expiresAt: row.invitation.expiresAt,
    expired: row.invitation.expiresAt.getTime() < Date.now(),
    signedInAs: user?.email ?? null,
    alreadyMember: Boolean(member),
    // On a server without email, someone new creates their account right here with a password
    canSignUpHere: !mailEnabled() && !(await userExists(row.invitation.email)),
  })
})

// { password, name? }: creates the invited person's account, signs them in and joins the
// organization. Only on servers without email, where the invitation link is how they get in.
invitations.post('/:token/sign-up', async (c) => {
  if (mailEnabled()) return c.json({ error: 'Sign up with your email to accept.', code: 'email_enabled' }, 409)
  const row = await findInvitation(c.req.param('token'))
  if (!row) return c.json({ error: 'This invitation is not valid. It may have been revoked or already accepted.' }, 404)
  if (row.invitation.expiresAt.getTime() < Date.now()) return c.json({ error: 'This invitation has expired. Ask for a new one.' }, 410)
  if (await userExists(row.invitation.email)) {
    return c.json({ error: `${row.invitation.email} already has an account. Log in to accept.`, code: 'account_exists' }, 409)
  }
  const body = (await c.req.json().catch(() => null)) as { password?: unknown; name?: unknown } | null
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null

  const user = await createPasswordAccount(row.invitation.email, name, await hashPassword(body!.password as string))
  if (!user) return c.json({ error: `${row.invitation.email} already has an account. Log in to accept.`, code: 'account_exists' }, 409)
  await startSession(c, user.id)
  return c.json(await join(user, row.invitation, row.org), 201)
})

invitations.post('/:token/accept', requireUser, async (c) => {
  const user = c.get('user')!
  const row = await findInvitation(c.req.param('token'))
  if (!row) return c.json({ error: 'This invitation is not valid. It may have been revoked or already accepted.' }, 404)
  if (row.invitation.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'This invitation has expired. Ask for a new one.' }, 410)
  }
  if (row.invitation.email !== user.email) {
    return c.json({ error: `This invitation is for ${row.invitation.email}. You are signed in as ${user.email}.`, code: 'email_mismatch' }, 403)
  }

  return c.json(await join(user, row.invitation, row.org))
})

type InvitationRow = typeof schema.invitations.$inferSelect
type OrganizationRow = typeof schema.organizations.$inferSelect

// Accepting an invitation, from the email link or from inside the app
async function join(user: User, invitation: InvitationRow, org: OrganizationRow) {
  await db.transaction(async (tx) => {
    // Already a member (joined another way): keep the role they have
    await tx
      .insert(schema.memberships)
      .values({ userId: user.id, organizationId: org.id, role: invitation.role })
      .onConflictDoNothing()
    await tx.delete(schema.invitations).where(eq(schema.invitations.id, invitation.id))
    // Joining a team counts as setting up a workspace
    if (!user.onboardedAt) await tx.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, user.id))
  })
  const joined = await membershipOf(org.id, user.id)
  return { id: org.id, name: org.name, slug: org.slug, role: joined!.role }
}

invitations.post('/:token/decline', requireUser, async (c) => {
  const user = c.get('user')!
  const row = await findInvitation(c.req.param('token'))
  if (!row) return c.body(null, 204)
  if (row.invitation.email !== user.email) {
    return c.json({ error: `This invitation is for ${row.invitation.email}. You are signed in as ${user.email}.`, code: 'email_mismatch' }, 403)
  }
  await db.delete(schema.invitations).where(eq(schema.invitations.id, row.invitation.id))
  return c.body(null, 204)
})

// Invitations to the signed-in person's email, so they can join without the email link.
// Mounted at /api/me/invitations.
export const myInvitations = new Hono<AuthEnv>()
myInvitations.use(requireUser)

myInvitations.get('/', async (c) => {
  const user = c.get('user')!
  const rows = await db
    .select({
      id: schema.invitations.id,
      role: schema.invitations.role,
      expiresAt: schema.invitations.expiresAt,
      createdAt: schema.invitations.createdAt,
      orgId: schema.organizations.id,
      orgName: schema.organizations.name,
      orgSlug: schema.organizations.slug,
      inviterName: schema.users.name,
      inviterEmail: schema.users.email,
    })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.invitations.organizationId, schema.organizations.id))
    .leftJoin(schema.users, eq(schema.invitations.invitedBy, schema.users.id))
    .where(
      and(
        eq(schema.invitations.email, user.email),
        gt(schema.invitations.expiresAt, new Date()),
        // Someone who joined another way has nothing to accept
        notExists(
          db
            .select({ one: schema.memberships.userId })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.organizationId, schema.invitations.organizationId), eq(schema.memberships.userId, user.id))),
        ),
      ),
    )
    .orderBy(asc(schema.invitations.createdAt))
  return c.json(
    rows.map((r) => ({
      id: r.id,
      organization: { id: r.orgId, name: r.orgName, slug: r.orgSlug },
      role: r.role,
      invitedBy: r.inviterName ?? r.inviterEmail,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    })),
  )
})

// The invitation by id, only when it is for this person's email; others look missing
async function ownInvitation(c: Context<AuthEnv>) {
  const id = c.req.param('id') ?? ''
  if (!UUID_RE.test(id)) return null
  const [row] = await db
    .select({ invitation: schema.invitations, org: schema.organizations })
    .from(schema.invitations)
    .innerJoin(schema.organizations, eq(schema.invitations.organizationId, schema.organizations.id))
    .where(and(eq(schema.invitations.id, id), eq(schema.invitations.email, c.get('user')!.email)))
  return row ?? null
}

myInvitations.post('/:id/accept', async (c) => {
  const row = await ownInvitation(c)
  if (!row) return c.json({ error: 'This invitation is not valid. It may have been revoked or already accepted.' }, 404)
  if (row.invitation.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'This invitation has expired. Ask for a new one.' }, 410)
  }
  return c.json(await join(c.get('user')!, row.invitation, row.org))
})

myInvitations.post('/:id/decline', async (c) => {
  const row = await ownInvitation(c)
  if (!row) return c.json({ error: 'This invitation is not valid. It may have been revoked or already accepted.' }, 404)
  await db.delete(schema.invitations).where(eq(schema.invitations.id, row.invitation.id))
  return c.body(null, 204)
})
