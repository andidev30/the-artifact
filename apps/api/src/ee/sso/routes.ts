import { and, eq, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { audit } from '../../audit.js'
import type { AuthEnv } from '../../auth/session.js'
import { continueSignIn } from '../../auth/twofactor.js'
import { AccountSuspendedError, afterSignInUrl, findOrCreateUser, safeNext, signInErrorUrl, SignupClosedError } from '../../auth/users.js'
import { db, schema } from '../../db/index.js'
import type { SsoConnection, User } from '../../db/schema.js'
import { env, isProduction } from '../../env.js'
import { isInstanceAdmin } from '../../instance.js'
import { requireEnterprise } from '../../license.js'
import { clientIp, defineLimit, limitRequest } from '../../limits.js'
import { log } from '../../log.js'
import { EMAIL_RE } from '../../validation.js'
import {
  coversDomain,
  describeConnection,
  findConnection,
  oidcConfig,
  oidcRedirectUri,
  openConnectionSecret,
  parseConnection,
  sealConnectionSecret,
  usableConnection,
  type ConnectionInput,
} from './connections.js'
import { acsUrl, describeSaml, parseSamlConnection, spEntityId, startSaml } from './saml.js'
import { authorizationUrl, discover, finishOidc, newChecks, OidcSetupError, oidcErrorText, type SsoIdentity } from './oidc.js'

// Starting an SSO sign-in and coming back from the provider, from one address
defineLimit('sso-ip', { max: 100, seconds: 15 * 60 })

const FLOW_COOKIE = 'sso_flow'
const FLOW = { path: '/api/auth/sso', httpOnly: true, secure: isProduction, sameSite: 'Lax', maxAge: 600 } as const
const TEST_COOKIE = 'sso_test'
const TEST = { path: '/api/admin/sso', httpOnly: true, secure: isProduction, sameSite: 'Lax', maxAge: 300 } as const

// What the round trip carries in its cookie. `test` is the instance admin who started a test of the
// connection: the result goes back to them and nobody is signed in.
type Flow = { c: string; s: string; n: string; v: string; next?: string | null; plan?: string | null; test?: string }

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function decode<T>(value: string | undefined): T | null {
  if (!value) return null
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

async function startFlow(c: Context, conn: SsoConnection, extra: Pick<Flow, 'next' | 'plan' | 'test'>): Promise<Response> {
  const checks = newChecks()
  let url: string
  try {
    url = await authorizationUrl(conn, checks)
  } catch (err) {
    log.warn('SSO provider unreachable', { err, connectionId: conn.id })
    if (extra.test) return finishTest(c, { connectionId: conn.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    return c.redirect(signInErrorUrl('sso_failed'))
  }
  const flow: Flow = { c: conn.id, s: checks.state, n: checks.nonce, v: checks.verifier, ...extra }
  setCookie(c, FLOW_COOKIE, encode(flow), FLOW)
  return c.redirect(url)
}

type TestResult = {
  connectionId: string
  ok: boolean
  error?: string
  subject?: string
  email?: string | null
  emailVerified?: boolean
  name?: string | null
  // Whether this address would get in: verified (or trusted) and at an allowed domain
  accepted?: boolean
}

// The result stays in a short-lived cookie only the admin API reads, so nothing the provider sent
// ends up in a URL
function finishTest(c: Context, result: TestResult): Response {
  setCookie(c, TEST_COOKIE, encode(result), TEST)
  return c.redirect(new URL('/admin?sso-test=1#sso', env.appUrl).toString())
}

// Why an identity can't sign in, as a /login?error= code, or null when it can
function refusal(conn: SsoConnection, identity: SsoIdentity): string | null {
  if (!identity.email || !EMAIL_RE.test(identity.email)) return 'sso_no_email'
  // Linking to an existing account by address is only safe for addresses the provider checked
  if (!identity.emailVerified && !oidcConfig(conn).trustEmail) return 'sso_unverified'
  if (!coversDomain(conn, identity.email)) return 'sso_domain'
  return null
}

// The account a provider's person signs in to: the one already linked to their subject, else the
// account with their (verified) address, else a new one. New accounts skip the sign-up policy only
// when the connection lists its domains; a connection open to any address follows the policy, so
// a provider anyone can sign up at (a public Google client, say) doesn't open the server to all.
export async function accountFor(conn: SsoConnection, identity: SsoIdentity & { email: string }): Promise<User> {
  const [linked] = await db
    .select({ user: schema.users })
    .from(schema.ssoIdentities)
    .innerJoin(schema.users, eq(schema.ssoIdentities.userId, schema.users.id))
    .where(and(eq(schema.ssoIdentities.connectionId, conn.id), eq(schema.ssoIdentities.subject, identity.subject)))
  if (linked) {
    if (linked.user.suspendedAt) throw new AccountSuspendedError()
    await db
      .update(schema.ssoIdentities)
      .set({ email: identity.email, lastUsedAt: new Date() })
      .where(and(eq(schema.ssoIdentities.connectionId, conn.id), eq(schema.ssoIdentities.subject, identity.subject)))
    return linked.user
  }

  const user = await findOrCreateUser({ email: identity.email, name: identity.name, approved: conn.allowedDomains.length > 0 })
  const [created] = await db
    .insert(schema.ssoIdentities)
    .values({ connectionId: conn.id, userId: user.id, subject: identity.subject, email: identity.email })
    .onConflictDoNothing()
    .returning({ id: schema.ssoIdentities.id })
  // Only the first time: someone an organization admin removes later isn't added back at each sign-in
  if (created && conn.organizationId) {
    const joined = await db
      .insert(schema.memberships)
      .values({ userId: user.id, organizationId: conn.organizationId, role: 'member' })
      .onConflictDoNothing()
      .returning({ role: schema.memberships.role })
    if (joined.length) {
      audit({
        action: 'member.joined',
        organizationId: conn.organizationId,
        actor: user,
        target: { type: 'member', id: user.id, label: user.email },
        details: { role: 'member', via: 'single sign-on', connection: conn.name },
      })
    }
  }
  return user
}

// Mounted at /api/auth/sso
export const ssoSignIn = new Hono<AuthEnv>()

ssoSignIn.use(async (c, next) => {
  if (!env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  await next()
})

ssoSignIn.get('/oidc/callback', async (c) => {
  const flow = decode<Flow>(getCookie(c, FLOW_COOKIE))
  deleteCookie(c, FLOW_COOKIE, { path: FLOW.path })
  const busy = await limitRequest(c, 'sso-ip', clientIp(c), 'Too many sign-in attempts from your network.')
  if (busy) return busy
  if (!flow?.c || !flow.s || !flow.n || !flow.v) return c.redirect(signInErrorUrl('sso_failed'))

  // A test is only for the admin who started it, still signed in and still an admin
  const user = c.get('user')
  const testing = Boolean(flow.test && user && user.id === flow.test && isInstanceAdmin(user))
  if (flow.test && !testing) return c.redirect(signInErrorUrl('sso_failed'))
  const conn = testing ? await findConnection(flow.c) : await usableConnection(flow.c)
  if (conn?.protocol !== 'oidc') return c.redirect(signInErrorUrl('sso_unavailable'))

  const error = c.req.query('error')
  if (error) {
    if (testing)
      return finishTest(c, { connectionId: conn.id, ok: false, error: `The provider answered ${error}: ${c.req.query('error_description') ?? ''}`.trim() })
    return c.redirect(signInErrorUrl(error === 'access_denied' ? 'sso_cancelled' : 'sso_failed'))
  }

  let identity: SsoIdentity
  try {
    identity = await finishOidc(conn, new URL(c.req.url).search, { state: flow.s, nonce: flow.n, verifier: flow.v })
  } catch (err) {
    log.warn('SSO sign-in failed', { err, reason: oidcErrorText(err), connectionId: conn.id })
    if (testing) return finishTest(c, { connectionId: conn.id, ok: false, error: oidcErrorText(err) })
    return c.redirect(signInErrorUrl('sso_failed'))
  }

  const refused = refusal(conn, identity)
  if (testing) return finishTest(c, { connectionId: conn.id, ok: true, ...identity, accepted: !refused })
  if (refused) return c.redirect(signInErrorUrl(refused))

  try {
    const account = await accountFor(conn, identity as SsoIdentity & { email: string })
    log.info('Signed in with SSO', { userId: account.id, connectionId: conn.id })
    return c.redirect(await continueSignIn(c, account, afterSignInUrl(flow.plan, flow.next), 'sso'))
  } catch (err) {
    if (err instanceof SignupClosedError) return c.redirect(signInErrorUrl(err.code))
    throw err
  }
})

// Starts signing in through a connection; ?next= and ?plan= as for the other ways in
ssoSignIn.get('/:id', async (c) => {
  const busy = await limitRequest(c, 'sso-ip', clientIp(c), 'Too many sign-in attempts from your network.')
  if (busy) return busy
  const conn = await usableConnection(c.req.param('id'))
  if (conn?.protocol === 'saml') return startSaml(c, conn, safeNext(c.req.query('next')))
  if (conn?.protocol !== 'oidc') return c.redirect(signInErrorUrl('sso_unavailable'))
  return startFlow(c, conn, { next: safeNext(c.req.query('next')), plan: c.req.query('plan') ?? null })
})

// Mounted at /api/admin/sso: instance admins of a self-hosted install with an Enterprise license
export const ssoAdmin = new Hono<AuthEnv>()

ssoAdmin.use(async (c, next) => {
  if (!env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  const user = c.get('user')
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!isInstanceAdmin(user)) return c.json({ error: 'Only instance admins can open this.', code: 'not_admin' }, 403)
  await next()
})
ssoAdmin.use(requireEnterprise)

async function listing() {
  const rows = await db.select().from(schema.ssoConnections).orderBy(schema.ssoConnections.createdAt)
  const organizations = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .orderBy(sql`lower(${schema.organizations.name})`)
    .limit(500)
  return {
    redirectUri: oidcRedirectUri(),
    // What a SAML IdP needs from this server, the same for every SAML connection
    saml: { entityId: spEntityId(), acsUrl: acsUrl() },
    connections: rows.map(describe),
    organizations,
  }
}

ssoAdmin.get('/', async (c) => c.json(await listing()))

// The result of the last "Test connection", once
ssoAdmin.get('/test-result', (c) => {
  const result = decode<TestResult>(getCookie(c, TEST_COOKIE))
  deleteCookie(c, TEST_COOKIE, { path: TEST.path })
  if (!result) return c.json({ error: 'There is no test result. Test the connection again.' }, 404)
  return c.json(result)
})

const describe = (conn: SsoConnection) => (conn.protocol === 'saml' ? describeSaml(conn) : describeConnection(conn))

// A SAML connection, added (existing null) or changed; the IdP comes from its metadata
async function saveSaml(c: Context, existing: SsoConnection | null): Promise<Response> {
  const parsed = await parseSamlConnection(await c.req.json().catch(() => null), existing)
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  const v = parsed.shared
  if (!(await checkOrganization(v.organizationId))) return c.json({ error: 'That organization no longer exists.', field: 'organizationId' }, 400)
  const values = {
    name: v.name,
    enabled: v.enabled,
    config: parsed.config,
    allowedDomains: v.allowedDomains,
    required: v.required,
    organizationId: v.organizationId,
  }
  const [row] = existing
    ? await db
        .update(schema.ssoConnections)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.ssoConnections.id, existing.id))
        .returning()
    : await db
        .insert(schema.ssoConnections)
        .values({ protocol: 'saml', createdBy: c.get('user')!.id, ...values })
        .returning()
  log.info(existing ? 'SSO connection changed' : 'SSO connection added', { connectionId: row.id, userId: c.get('user')!.id })
  return c.json(describeSaml(row), existing ? 200 : 201)
}

async function checkOrganization(id: string | null): Promise<boolean> {
  if (!id) return true
  const [org] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, id))
  return Boolean(org)
}

// Reads the provider's settings with these values, so a typo in the issuer shows up on saving
async function checkProvider(value: ConnectionInput, secret: string) {
  try {
    await discover({ issuer: value.issuer, clientId: value.clientId, trustEmail: value.trustEmail }, secret)
    return null
  } catch (err) {
    return err instanceof OidcSetupError ? err.message : 'The provider’s settings could not be read. Check the issuer URL.'
  }
}

ssoAdmin.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if ((body as { protocol?: unknown } | null)?.protocol === 'saml') return saveSaml(c, null)
  const parsed = parseConnection(body, true)
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  const v = parsed.value
  if (!(await checkOrganization(v.organizationId))) return c.json({ error: 'That organization no longer exists.', field: 'organizationId' }, 400)
  const problem = await checkProvider(v, v.clientSecret as string)
  if (problem) return c.json({ error: problem, field: 'issuer' }, 400)
  const [row] = await db
    .insert(schema.ssoConnections)
    .values({
      protocol: 'oidc',
      name: v.name,
      enabled: v.enabled,
      config: { issuer: v.issuer, clientId: v.clientId, trustEmail: v.trustEmail },
      secret: await sealConnectionSecret(v.clientSecret as string),
      allowedDomains: v.allowedDomains,
      required: v.required,
      organizationId: v.organizationId,
      createdBy: c.get('user')!.id,
    })
    .returning()
  log.info('SSO connection added', { connectionId: row.id, userId: c.get('user')!.id })
  return c.json(describeConnection(row), 201)
})

ssoAdmin.put('/:id', async (c) => {
  const conn = await findConnection(c.req.param('id'))
  if (!conn) return c.json({ error: 'This connection no longer exists.' }, 404)
  if (conn.protocol === 'saml') return saveSaml(c, conn)
  const parsed = parseConnection(await c.req.json().catch(() => null), false)
  if (!parsed.ok) return c.json({ error: parsed.error, field: parsed.field }, 400)
  const v = parsed.value
  if (!(await checkOrganization(v.organizationId))) return c.json({ error: 'That organization no longer exists.', field: 'organizationId' }, 400)
  const old = oidcConfig(conn)
  if (v.clientSecret || v.issuer !== old.issuer || v.clientId !== old.clientId) {
    const secret = v.clientSecret ?? (conn.secret ? await openConnectionSecret(conn.secret) : '')
    const problem = await checkProvider(v, secret)
    if (problem) return c.json({ error: problem, field: 'issuer' }, 400)
  }
  const [row] = await db
    .update(schema.ssoConnections)
    .set({
      name: v.name,
      enabled: v.enabled,
      config: { issuer: v.issuer, clientId: v.clientId, trustEmail: v.trustEmail },
      ...(v.clientSecret ? { secret: await sealConnectionSecret(v.clientSecret) } : {}),
      allowedDomains: v.allowedDomains,
      required: v.required,
      organizationId: v.organizationId,
      updatedAt: new Date(),
    })
    .where(eq(schema.ssoConnections.id, conn.id))
    .returning()
  log.info('SSO connection changed', { connectionId: row.id, userId: c.get('user')!.id })
  return c.json(describeConnection(row))
})

// People keep their accounts; those who only ever signed in through it need another way in
ssoAdmin.delete('/:id', async (c) => {
  const conn = await findConnection(c.req.param('id'))
  if (!conn) return c.json({ error: 'This connection no longer exists.' }, 404)
  await db.delete(schema.ssoConnections).where(eq(schema.ssoConnections.id, conn.id))
  log.info('SSO connection removed', { connectionId: conn.id, userId: c.get('user')!.id })
  return c.body(null, 204)
})

// "Test connection": the admin goes through the provider's sign-in, even while the connection is
// off, and comes back to the admin page with what the provider sent. Nobody is signed in or linked.
ssoAdmin.get('/:id/test', async (c) => {
  const conn = await findConnection(c.req.param('id'))
  if (conn?.protocol !== 'oidc') return c.json({ error: 'This connection no longer exists.' }, 404)
  return startFlow(c, conn, { test: c.get('user')!.id })
})
