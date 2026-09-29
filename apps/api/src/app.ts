import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { contextStorage } from 'hono/context-storage'
import { setProductEventStore } from './analytics.js'
import { setAuditStore } from './audit.js'
import { autoJoinNotices, dismissAutoJoinNotice } from './auto-join.js'
import { UUID_RE } from './validation.js'
import { email } from './auth/email.js'
import { google } from './auth/google.js'
import { sameOriginWrites } from './auth/origin.js'
import { password, passwordSignUpOpen } from './auth/password.js'
import { hasSecondFactor } from './auth/factors.js'
import { endSession, loadUser, requireUser, type AuthEnv } from './auth/session.js'
import { clearPending, passkeySignIn, twoFactor } from './auth/twofactor.js'
import { db, schema } from './db/index.js'
import { productAnalytics, productEventStore, pruneProductEvents } from './ee/analytics.js'
import { auditLog, auditStore, pruneAuditEvents } from './ee/audit.js'
import { contact } from './ee/contact.js'
import { issuedLicenses } from './ee/licenses.js'
import { historyCron, organizationPlan, personalPlan } from './ee/plans.js'
import { pruneRetention, retention } from './ee/retention.js'
import { ssoButtons } from './ee/sso/connections.js'
import { ssoAdmin, ssoSignIn } from './ee/sso/routes.js'
import { samlSignIn } from './ee/sso/saml.js'
import { MAX_METADATA_BYTES } from './ee/sso/saml-metadata.js'
import { scim, scimAdmin } from './ee/scim.js'
import { contentHost, onContentHost } from './content.js'
import { embeds } from './embeds.js'
import { exportsApi } from './routes/exports.js'
import { env, mailEnabled } from './env.js'
import { addPruner } from './gc.js'
import { hasAccountsCached, instanceSettings, isInstanceAdmin } from './instance.js'
import { checkRateLimits } from './limits.js'
import { mcp } from './mcp.js'
import { observeRequests, onUnhandledError } from './metrics.js'
import { consent } from './oauth/consent.js'
import { oauth } from './oauth/server.js'
import { setPlanQuota } from './quota.js'
import { admin } from './routes/admin.js'
import { cron } from './routes/cron.js'
import { health } from './routes/health.js'
import { publishApi, whoamiApi } from './routes/publish.js'
import { artifacts } from './routes/artifacts.js'
import { comments } from './routes/comments.js'
import { folders } from './routes/folders.js'
import { invitations, members, myInvitations } from './routes/members.js'
import { newOrganizationsOpen, onboarding, organizations, setOrganizationPolicy } from './routes/organizations.js'
import { security, sessions } from './routes/security.js'
import { settings } from './routes/settings.js'
import { organizationWebhooks, personalWebhooks } from './routes/webhooks.js'
import { tags } from './routes/tags.js'
import { mountWeb, strictTransportSecurity } from './web.js'
import { pruneWebhookDeliveries } from './webhooks.js'

export const app = new Hono<AuthEnv>()

// First, so every request gets an id, a log line and its timing
app.use(observeRequests)
app.onError(onUnhandledError)
// Browsers take every response as the type it declares and never guess one from the body: API errors,
// the app shell and its assets, health checks and redirects included. HSTS on all of them too.
app.use(async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  const hsts = strictTransportSecurity()
  if (hsts) c.header('Strict-Transport-Security', hsts)
})

// Bodies are read whole into memory, most of them before anyone is signed in, so a request carries at
// most 1 MB unless its route needs more. /api/publish sets its own limit from the page size limits, and
// /mcp reads a body only once the token checks out, up to the MCP SDK's own limit (its 413 is an
// error MCP clients understand).
const MB = 1024 * 1024
const maxBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ error: `This request is too large. It can be up to ${maxSize / MB} MB.` }, 413) })
const DEFAULT_BODY = maxBody(MB)
// SAML metadata pasted by an admin, escaped as JSON
const SSO_SETTINGS_BODY = maxBody(2 * MAX_METADATA_BYTES + MB)
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
app.use((c, next) => {
  const path = c.req.path
  if (under(path, '/mcp') || under(path, '/api/publish')) return next()
  return (under(path, '/api/admin/sso') ? SSO_SETTINGS_BODY : DEFAULT_BODY)(c, next)
})
// CONTENT_ORIGIN serves page files and nothing else: a page that escaped its sandbox there finds no app
app.use(async (c, next) => {
  if (onContentHost(c)) return contentHost.fetch(c.req.raw, c.env)
  await next()
})
// Lets audit() read the request (address, user agent) wherever it is called from
app.use(contextStorage())
app.route('/', health)

// The hosted service's plan limits. They check SELF_HOSTED themselves, so a self-hosted install gets
// only its own WORKSPACE_MAX_* settings and can always create organizations.
setPlanQuota(personalPlan)
setOrganizationPolicy(organizationPlan)
// Version retention for organizations with an Enterprise license; checks the license itself
addPruner(pruneRetention)
// Organizations' audit log, kept only while the install has an Enterprise license
setAuditStore(auditStore)
addPruner(pruneAuditEvents)
// The hosted service's sign-up funnel; records nothing on a self-hosted install
setProductEventStore(productEventStore)
addPruner(pruneProductEvents)
// Webhook delivery logs older than two weeks
addPruner(pruneWebhookDeliveries)
// Every limit is defined by now, ee/ ones included; a mistake in RATE_LIMITS stops the start here
checkRateLimits()

if (!env.webDir) app.get('/', (c) => c.text('The Artifact API'))

// MCP endpoint and the OAuth server MCP clients sign in through
app.route('/', oauth)
app.route('/mcp', mcp)
// Bearer tokens only, outside the cookie-authenticated routes below
app.route('/api/publish', publishApi)
app.route('/api/whoami', whoamiApi)
// SCIM provisioning for an IdP (Enterprise, self-hosted): its own bearer tokens and error format
app.route('/scim/v2', scim)

// /e/<slug> and /api/oembed, outside the session middleware: embeds never look at who is signed in
app.route('/', embeds)

const api = new Hono<AuthEnv>()
// Before anything reads the session: writes come from the web app itself (see src/auth/origin.ts)
api.use(sameOriginWrites)
api.use(loadUser)

// What the web app needs to know about this install
api.get('/config', async (c) => {
  const [accounts, settings, sso] = await Promise.all([mailEnabled() && !env.selfHosted ? true : hasAccountsCached(), instanceSettings(), ssoButtons()])
  return c.json({
    selfHosted: env.selfHosted,
    googleSignIn: Boolean(env.google.clientId && env.google.clientSecret),
    // Without SMTP, people sign in with a password and admins pass links on by hand
    emailSignIn: mailEnabled(),
    // No accounts yet on a server without email: the web app shows the setup form
    needsSetup: !mailEnabled() && !accounts,
    // No accounts yet on a self-hosted install: the first one needs the setup code from the server log
    setupCode: env.selfHosted && !accounts,
    // Without email, whether people can create a password account on their own
    passwordSignUp: passwordSignUpOpen(settings),
    instanceName: settings.instanceName,
    // Off on the hosted service until the Organization plan has billing; the app hides the ways in
    newOrganizations: newOrganizationsOpen(),
    // Enterprise single sign-on buttons; none without a license that counts
    sso,
  })
})

api.route('/auth/google', google)
api.route('/auth/email', email)
api.route('/auth/password', password)
api.route('/auth/two-factor', twoFactor)
api.route('/auth/passkey', passkeySignIn)
api.route('/auth/sso/saml', samlSignIn)
api.route('/auth/sso', ssoSignIn)

api.post('/auth/logout', async (c) => {
  await endSession(c)
  clearPending(c)
  return c.body(null, 204)
})

api.route('/organizations', organizations)
api.route('/onboarding', onboarding)
api.route('/oauth/requests', consent)
api.route('/artifacts/:slug/comments', comments)
api.route('/artifacts', artifacts)
api.route('/folders', folders)
api.route('/exports', exportsApi)
api.route('/tags', tags)
api.route('/contact-sales', contact)

api.route('/organizations/:orgId/audit-log', auditLog)
api.route('/organizations/:orgId', members)
api.route('/organizations/:orgId/retention', retention)
api.route('/organizations/:orgId/webhooks', organizationWebhooks)
api.route('/invitations', invitations)
api.route('/me/invitations', myInvitations)
api.route('/me/security', security)
api.route('/me/sessions', sessions)
api.route('/me/webhooks', personalWebhooks)
api.route('/me', settings)
api.route('/admin/issued-licenses', issuedLicenses)
api.route('/admin/analytics', productAnalytics)
api.route('/admin/sso', ssoAdmin)
api.route('/admin/scim', scimAdmin)
api.route('/admin', admin)
api.route('/cron/history', historyCron)
api.route('/cron', cron)

api.get('/me', requireUser, async (c) => {
  const user = c.get('user')!
  const orgs = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      role: schema.memberships.role,
      requireTwoFactor: schema.organizations.requireTwoFactor,
    })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(eq(schema.memberships.userId, user.id))
    .orderBy(schema.memberships.createdAt)

  // Drives the getting-started checklist
  const [token] = await db.select({ id: schema.oauthTokens.id }).from(schema.oauthTokens).where(eq(schema.oauthTokens.userId, user.id)).limit(1)
  const [page] = await db.select({ id: schema.artifacts.id }).from(schema.artifacts).where(eq(schema.artifacts.ownerId, user.id)).limit(1)

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    hasPassword: Boolean(user.passwordHash),
    onboarded: user.onboardedAt !== null,
    // blocked: the organization requires a second factor this person hasn't set up yet
    organizations: orgs.map((o) => ({ ...o, blocked: user.blockedOrgs.includes(o.id) })),
    twoFactor: await hasSecondFactor(user.id),
    agentConnected: Boolean(token),
    hasPublished: Boolean(page),
    isAdmin: isInstanceAdmin(user),
    // Organizations joined by email domain whose notice is still to show
    autoJoined: await autoJoinNotices(user.id),
  })
})

api.post('/me/auto-joins/:orgId/dismiss', requireUser, async (c) => {
  const orgId = c.req.param('orgId')
  if (UUID_RE.test(orgId)) await dismissAutoJoinNotice(c.get('user')!.id, orgId)
  return c.body(null, 204)
})

app.route('/api', api)

if (env.webDir) mountWeb(app, env.webDir)
