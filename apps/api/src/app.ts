import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { email } from './auth/email.js'
import { google } from './auth/google.js'
import { endSession, loadUser, requireUser, type AuthEnv } from './auth/session.js'
import { db, schema } from './db/index.js'
import { onboarding, organizations } from './routes/organizations.js'

export const app = new Hono<AuthEnv>()

app.get('/', (c) => c.text('The Artifact API'))

const api = new Hono<AuthEnv>()
api.use(loadUser)

api.route('/auth/google', google)
api.route('/auth/email', email)

api.post('/auth/logout', async (c) => {
  await endSession(c)
  return c.body(null, 204)
})

api.route('/organizations', organizations)
api.route('/onboarding', onboarding)

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

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    onboarded: user.onboardedAt !== null,
    organizations: orgs,
  })
})

app.route('/api', api)
