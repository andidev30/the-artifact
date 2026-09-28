import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { requireUser, type AuthEnv } from '../auth/session.js'
import { track } from '../analytics.js'
import { db, schema } from '../db/index.js'

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
// Paths the web app already uses, so an organization can't take them
const RESERVED = new Set([
  'a',
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'contact-sales',
  'docs',
  'help',
  'login',
  'logout',
  'mcp',
  'new',
  'onboarding',
  'pricing',
  'settings',
  'signup',
  'support',
  'www',
])

export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return 'Use 3 to 40 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
  if (RESERVED.has(slug)) return 'That address is reserved. Pick another one.'
  return null
}

async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.slug, slug))
  return Boolean(row)
}

// Why new organizations can't be created right now, or null when they can. Set once by an entry point
// (src/app.ts sets the hosted service's rule from ee/); a self-hosted install keeps the default and
// always can. Existing organizations are never affected: members, invitations, pages and sharing.
export type OrganizationPolicy = () => string | null
let newOrganizationRefusal: OrganizationPolicy = () => null

export function setOrganizationPolicy(policy: OrganizationPolicy) {
  newOrganizationRefusal = policy
}

export function newOrganizationsOpen(): boolean {
  return newOrganizationRefusal() === null
}

export const organizations = new Hono<AuthEnv>()
organizations.use(requireUser)

organizations.get('/slug-available', async (c) => {
  const slug = (c.req.query('slug') ?? '').trim().toLowerCase()
  const problem = slugProblem(slug)
  if (problem) return c.json({ available: false, reason: problem })
  if (await slugTaken(slug)) return c.json({ available: false, reason: 'Another organization already uses this address.' })
  return c.json({ available: true })
})

organizations.post('/', async (c) => {
  const user = c.get('user')!
  const refusal = newOrganizationRefusal()
  if (refusal) return c.json({ error: refusal }, 403)
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; slug?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : ''

  if (name.length < 2 || name.length > 60) return c.json({ error: 'Use 2 to 60 characters for the name.', field: 'name' }, 400)
  const problem = slugProblem(slug)
  if (problem) return c.json({ error: problem, field: 'slug' }, 400)

  try {
    const org = await db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.organizations).values({ name, slug }).returning()
      await tx.insert(schema.memberships).values({ userId: user.id, organizationId: created.id, role: 'owner' })
      await tx.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, user.id))
      return created
    })
    if (!user.onboardedAt) track({ event: 'onboarded', userId: user.id, detail: 'organization' })
    return c.json({ id: org.id, name: org.name, slug: org.slug, role: 'owner' }, 201)
  } catch (err) {
    // Unique violation on slug: someone took it between the check and the insert
    if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
      return c.json({ error: 'Another organization already uses this address.', field: 'slug' }, 409)
    }
    throw err
  }
})

// Finishing onboarding with a personal workspace only needs a timestamp
export const onboarding = new Hono<AuthEnv>()
onboarding.use(requireUser)

onboarding.post('/personal', async (c) => {
  const user = c.get('user')!
  await db.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, user.id))
  if (!user.onboardedAt) track({ event: 'onboarded', userId: user.id, detail: 'personal' })
  return c.body(null, 204)
})
