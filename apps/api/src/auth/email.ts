import { and, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { sendSignInLink } from '../mail.js'
import { hashToken, randomToken, startSession } from './session.js'
import { afterSignInUrl, findOrCreateUser, signInErrorUrl } from './users.js'

const LINK_TTL = 15 * 60 * 1000
// Don't send another link to the same address within this window
const RESEND_AFTER = 60 * 1000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const email = new Hono()

email.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: unknown; intent?: unknown; plan?: unknown } | null
  const address = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(address)) return c.json({ error: 'Enter a valid email address.' }, 400)
  const intent = body?.intent === 'signup' ? 'signup' : 'login'
  const plan = typeof body?.plan === 'string' ? body.plan : null

  const [recent] = await db
    .select({ id: schema.emailTokens.id })
    .from(schema.emailTokens)
    .where(and(
      eq(schema.emailTokens.email, address),
      gt(schema.emailTokens.createdAt, new Date(Date.now() - RESEND_AFTER)),
    ))
  if (recent) return c.body(null, 204)

  const token = randomToken()
  await db.insert(schema.emailTokens).values({
    id: hashToken(token),
    email: address,
    expiresAt: new Date(Date.now() + LINK_TTL),
  })

  const link = new URL('/api/auth/email/verify', env.appUrl)
  link.searchParams.set('token', token)
  if (plan) link.searchParams.set('plan', plan)

  try {
    await sendSignInLink(address, link.toString(), intent)
  } catch (err) {
    console.error('Sending sign-in email failed', err)
    return c.json({ error: 'The link could not be sent.' }, 502)
  }
  return c.body(null, 204)
})

email.get('/verify', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.redirect(signInErrorUrl('link_invalid'))

  // Links work once: delete the token as it is read
  const [row] = await db
    .delete(schema.emailTokens)
    .where(eq(schema.emailTokens.id, hashToken(token)))
    .returning()
  if (!row) return c.redirect(signInErrorUrl('link_invalid'))
  if (row.expiresAt.getTime() < Date.now()) return c.redirect(signInErrorUrl('link_expired'))

  const user = await findOrCreateUser({ email: row.email })
  await startSession(c, user.id)
  return c.redirect(afterSignInUrl(c.req.query('plan')))
})
