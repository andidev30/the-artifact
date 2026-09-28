import { and, asc, count, eq, gt, notExists, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { track } from '../analytics.js'
import { audit } from '../audit.js'
import { hasSecondFactor, twoFactorRequiredError } from '../auth/factors.js'
import { hashPassword, passwordProblem } from '../auth/password.js'
import { hashToken, randomToken, requireUser, startSession, type AuthEnv } from '../auth/session.js'
import { createPasswordAccount, userExists } from '../auth/users.js'
import { db, schema } from '../db/index.js'
import type { InviteRole, Role, User } from '../db/schema.js'
import { ssoRequiredError, ssoRequiredFor } from '../ee/sso/connections.js'
import { env, mailEnabled } from '../env.js'
import { removeMembership } from '../instance.js'
import { limitInvites } from '../limits.js'
import { log } from '../log.js'
import { sendInvitation } from '../mail.js'
import { revokeToken, tokensIn } from '../tokens.js'
import { CONTROL_CHARS_ERROR, EMAIL_RE, hasControlChars, UUID_RE } from '../validation.js'

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

// The caller's membership in :orgId; organizations they don't belong to look missing
async function actor(c: Context<AuthEnv>) {
  const orgId = c.req.param('orgId') ?? ''
  if (!UUID_RE.test(orgId)) return null
  return membershipOf(orgId, c.get('user')!.id)
}

async function listMembers(organizationId: string) {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      role: schema.memberships.role,
      joinedAt: schema.memberships.createdAt,
      // A passkey or a confirmed authenticator app
      twoFactor: sql<boolean>`(exists (select 1 from ${schema.passkeys} where ${schema.passkeys.userId} = ${schema.users.id})
        or exists (select 1 from ${schema.totpSecrets} where ${schema.totpSecrets.userId} = ${schema.users.id} and ${schema.totpSecrets.confirmedAt} is not null))`,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
    .where(eq(schema.memberships.organizationId, organizationId))
    .orderBy(asc(schema.memberships.createdAt))
  return rows.map((r) => ({ ...r, twoFactor: Boolean(r.twoFactor) }))
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
    requireTwoFactor: org.requireTwoFactor,
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
// Members an organization blocks until they set up a second factor can still leave it
members.use(async (c, next) => {
  const orgId = c.req.param('orgId') ?? ''
  const user = c.get('user')!
  if (!user.blockedOrgs.includes(orgId)) return next()
  const leaving = c.req.method === 'DELETE' && c.req.path.endsWith(`/members/${user.id}`)
  if (leaving) return next()
  return c.json(await twoFactorRequiredError(orgId), 403)
})

members.get('/', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  return c.json(await details(me.org.id, me.role))
})

members.patch('/', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can change the organization.' }, 403)
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; requireTwoFactor?: unknown } | null
  const set: { name?: string; requireTwoFactor?: boolean } = {}
  if (body?.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length < 2 || name.length > 60) return c.json({ error: 'Use 2 to 60 characters for the name.', field: 'name' }, 400)
    if (hasControlChars(name)) return c.json({ error: CONTROL_CHARS_ERROR, field: 'name' }, 400)
    set.name = name
  }
  if (body?.requireTwoFactor !== undefined) {
    if (typeof body.requireTwoFactor !== 'boolean') return c.json({ error: 'Send requireTwoFactor as true or false.', field: 'requireTwoFactor' }, 400)
    // Otherwise the person turning it on would lock themselves out at once
    if (body.requireTwoFactor && !(await hasSecondFactor(c.get('user')!.id))) {
      return c.json({ error: 'Add a passkey or an authenticator app to your own account first.', code: 'two_factor_needed', field: 'requireTwoFactor' }, 409)
    }
    set.requireTwoFactor = body.requireTwoFactor
  }
  if (!Object.keys(set).length) return c.json({ error: 'Send a name or requireTwoFactor.' }, 400)
  await db.update(schema.organizations).set(set).where(eq(schema.organizations.id, me.org.id))
  const changes = Object.fromEntries(
    (Object.keys(set) as (keyof typeof set)[]).filter((k) => set[k] !== me.org[k]).map((k) => [k, { from: me.org[k], to: set[k] }]),
  )
  if (Object.keys(changes).length) {
    audit({
      action: 'organization.settings_changed',
      organizationId: me.org.id,
      actor: c.get('user')!,
      target: { type: 'organization', id: me.org.id, label: set.name ?? me.org.name },
      details: changes,
    })
  }
  if (set.requireTwoFactor !== undefined && set.requireTwoFactor !== me.org.requireTwoFactor) {
    log.info('Organization two-factor requirement changed', { organizationId: me.org.id, userId: c.get('user')!.id, requireTwoFactor: set.requireTwoFactor })
  }
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
  const busy = await limitInvites(c, user.id, 1)
  if (busy) return busy

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

  audit({ action: 'member.invited', organizationId: me.org.id, actor: user, target: { type: 'invitation', id: email, label: email }, details: { role } })
  const link = inviteUrl(token)
  // Without email, the person who invited passes the link on
  let emailed = mailEnabled()
  if (emailed) {
    try {
      await sendInvitation(email, { from: user.name ?? user.email, organization: me.org.name, role, link, expiresInDays: INVITE_DAYS })
    } catch (err) {
      log.error('Sending invitation email failed', { err })
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
    .returning({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role })
  if (!deleted.length) return c.json({ error: 'That invitation was already accepted or revoked.' }, 404)
  const [gone] = deleted
  audit({
    action: 'member.invitation_revoked',
    organizationId: me.org.id,
    actor: c.get('user')!,
    target: { type: 'invitation', id: gone.email, label: gone.email },
    details: { role: gone.role },
  })
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
    const changed = await db.transaction(async (tx) => {
      const owners = await ownerCount(tx, me.org.id)
      const [target] = UUID_RE.test(targetId)
        ? await tx
            .select({ role: schema.memberships.role, email: schema.users.email })
            .from(schema.memberships)
            .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
            .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
        : []
      if (!target) throw new RuleError('That person is not in this organization.', 404)
      if (target.role === role) return null
      if (!canManage(me.role, target.role) || !canManage(me.role, role)) {
        throw new RuleError(me.role === 'member' ? 'Only owners and admins can change roles.' : 'Only owners can change an owner or make someone an owner.')
      }
      if (target.role === 'owner' && owners <= 1) {
        throw new RuleError(
          targetId === user.id ? 'You are the only owner. Make someone else an owner before changing your role.' : 'An organization needs at least one owner.',
          409,
        )
      }
      await tx
        .update(schema.memberships)
        .set({ role })
        .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
      return target
    })
    if (changed) {
      audit({
        action: 'member.role_changed',
        organizationId: me.org.id,
        actor: user,
        target: { type: 'member', id: targetId, label: changed.email },
        details: { from: changed.role, to: role },
      })
    }
  } catch (err) {
    return fail(c, err)
  }
  const after = await membershipOf(me.org.id, user.id)
  return c.json(await details(me.org.id, after?.role ?? me.role))
})

// Every member's access tokens for this organization. Owners and admins see them and can revoke
// any of them, whoever made it, so a token that leaks can be stopped without waiting for its owner.
members.get('/access-tokens', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can see the access tokens of an organization.' }, 403)
  return c.json(await tokensIn(me.org.id))
})

members.delete('/access-tokens/:id', async (c) => {
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  if (me.role === 'member') return c.json({ error: 'Only owners and admins can revoke access tokens of other people.' }, 403)
  const id = c.req.param('id')
  if (!UUID_RE.test(id) || !(await revokeToken(id, { organizationId: me.org.id }, c.get('user')!))) {
    return c.json({ error: 'That access token was already revoked.' }, 404)
  }
  return c.body(null, 204)
})

// Removing yourself is leaving; anyone can leave, except the last owner
members.delete('/members/:userId', async (c) => {
  const user = c.get('user')!
  const me = await actor(c)
  if (!me) return c.json({ error: 'Not found' }, 404)
  const targetId = c.req.param('userId')
  const leaving = targetId === user.id

  try {
    const removed = await db.transaction(async (tx) => {
      const owners = await ownerCount(tx, me.org.id)
      const [target] = UUID_RE.test(targetId)
        ? await tx
            .select({ role: schema.memberships.role, email: schema.users.email })
            .from(schema.memberships)
            .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
            .where(and(eq(schema.memberships.organizationId, me.org.id), eq(schema.memberships.userId, targetId)))
        : []
      if (!target) throw new RuleError('That person is not in this organization.', 404)
      if (!leaving && !canManage(me.role, target.role)) {
        throw new RuleError(me.role === 'member' ? 'Only owners and admins can remove people.' : 'Only owners can remove an owner.')
      }
      if (target.role === 'owner' && owners <= 1) {
        throw new RuleError(leaving ? 'You are the only owner. Make someone else an owner before you leave.' : 'An organization needs at least one owner.', 409)
      }
      await removeMembership(tx, me.org.id, targetId)
      return target
    })
    audit({
      action: leaving ? 'member.left' : 'member.removed',
      organizationId: me.org.id,
      actor: user,
      target: { type: 'member', id: targetId, label: removed.email },
      details: { role: removed.role },
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
  const [member] = user
    ? await db
        .select({ role: schema.memberships.role })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, row.org.id), eq(schema.memberships.userId, user.id)))
    : []
  const [{ value: memberCount }] = await db.select({ value: count() }).from(schema.memberships).where(eq(schema.memberships.organizationId, row.org.id))
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
  if (await ssoRequiredFor({ email: row.invitation.email, isAdmin: false, suspendedAt: null })) return c.json(ssoRequiredError, 403)
  const body = (await c.req.json().catch(() => null)) as { password?: unknown; name?: unknown } | null
  const problem = passwordProblem(body?.password)
  if (problem) return c.json({ error: problem, field: 'password' }, 400)
  const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null
  if (name && hasControlChars(name)) return c.json({ error: CONTROL_CHARS_ERROR, field: 'name' }, 400)

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
  const inserted = await db.transaction(async (tx) => {
    // Already a member (joined another way): keep the role they have
    const rows = await tx
      .insert(schema.memberships)
      .values({ userId: user.id, organizationId: org.id, role: invitation.role })
      .onConflictDoNothing()
      .returning({ role: schema.memberships.role })
    await tx.delete(schema.invitations).where(eq(schema.invitations.id, invitation.id))
    // Joining a team counts as setting up a workspace
    if (!user.onboardedAt) await tx.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, user.id))
    return rows.length > 0
  })
  const joined = await membershipOf(org.id, user.id)
  if (!user.onboardedAt) track({ event: 'onboarded', userId: user.id, detail: 'invitation' })
  if (inserted) {
    audit({
      action: 'member.joined',
      organizationId: org.id,
      actor: user,
      target: { type: 'member', id: user.id, label: user.email },
      details: { role: joined!.role },
    })
  }
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
// Mounted at /api/me/invitations. Only for accounts whose address was checked: someone who signed
// up with a password on a server without email may have typed another person's address, so they
// join with the invitation link the inviter passed on, like a new account would.
export const myInvitations = new Hono<AuthEnv>()
myInvitations.use(requireUser)

myInvitations.get('/', async (c) => {
  const user = c.get('user')!
  if (user.emailUnverified) return c.json([])
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
  if (!UUID_RE.test(id) || c.get('user')!.emailUnverified) return null
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
