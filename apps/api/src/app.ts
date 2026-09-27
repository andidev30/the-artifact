import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { email } from './auth/email.js'
import { google } from './auth/google.js'
import { password, passwordSignUpOpen } from './auth/password.js'
import { endSession, loadUser, requireUser, type AuthEnv } from './auth/session.js'
import { db, schema } from './db/index.js'
import { contact } from './ee/contact.js'
import { env, mailEnabled } from './env.js'
import { hasAccounts, instanceSettings, isInstanceAdmin } from './instance.js'
import { mcp } from './mcp.js'
import { consent } from './oauth/consent.js'
import { oauth } from './oauth/server.js'
import { admin } from './routes/admin.js'
import { artifacts } from './routes/artifacts.js'
import { invitations, members, myInvitations } from './routes/members.js'
import { onboarding, organizations } from './routes/organizations.js'
import { settings } from './routes/settings.js'
import { mountWeb } from './web.js'

export const app = new Hono<AuthEnv>()

if (!env.webDir) app.get('/', (c) => c.text('The Artifact API'))

// MCP endpoint and the OAuth server MCP clients sign in through
app.route('/', oauth)
app.route('/mcp', mcp)

const api = new Hono<AuthEnv>()
api.use(loadUser)

// What the web app needs to know about this install
api.get('/config', async (c) =>
  c.json({
    selfHosted: env.selfHosted,
    googleSignIn: Boolean(env.google.clientId && env.google.clientSecret),
    // Without SMTP, people sign in with a password and admins pass links on by hand
    emailSignIn: mailEnabled(),
    // No accounts yet on a server without email: the web app shows the setup form
    needsSetup: !mailEnabled() && !(await hasAccounts()),
    // Without email, whether people can create a password account on their own
    passwordSignUp: await passwordSignUpOpen(),
    instanceName: (await instanceSettings()).instanceName,
  }),
)

api.route('/auth/google', google)
api.route('/auth/email', email)
api.route('/auth/password', password)

api.post('/auth/logout', async (c) => {
  await endSession(c)
  return c.body(null, 204)
})

api.route('/organizations', organizations)
api.route('/onboarding', onboarding)
api.route('/oauth/requests', consent)
api.route('/artifacts', artifacts)
api.route('/contact-sales', contact)

api.route('/organizations/:orgId', members)
api.route('/invitations', invitations)
api.route('/me/invitations', myInvitations)
api.route('/me', settings)
api.route('/admin', admin)

api.get('/me', requireUser, async (c) => {
  const user = c.get('user')!
  const orgs = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      role: schema.memberships.role,
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
    organizations: orgs,
    agentConnected: Boolean(token),
    hasPublished: Boolean(page),
    isAdmin: isInstanceAdmin(user),
  })
})

app.route('/api', api)

if (env.webDir) mountWeb(app, env.webDir)
