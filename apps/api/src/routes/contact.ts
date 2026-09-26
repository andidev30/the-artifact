import { Hono } from 'hono'
import { sendSalesInquiry } from '../mail.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Control characters (newlines included) have no place in one-line fields that end up in a subject
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export const TEAM_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const
const TOPICS: Record<string, string> = {
  enterprise: 'Enterprise',
  'self-hosted-enterprise': 'Self-hosted Enterprise',
}

// At most this many messages per address in the window, kept in memory: enough to stop a loop, not a determined sender
const LIMIT = 3
const WINDOW = 60 * 60 * 1000
const recent = new Map<string, number[]>()

function allow(address: string): boolean {
  const now = Date.now()
  const times = (recent.get(address) ?? []).filter((t) => now - t < WINDOW)
  if (times.length >= LIMIT) {
    recent.set(address, times)
    return false
  }
  times.push(now)
  recent.set(address, times)
  // Keep the map from growing without bound
  if (recent.size > 10_000) for (const [k, v] of recent) if (v.every((t) => now - t >= WINDOW)) recent.delete(k)
  return true
}

type Field = 'name' | 'email' | 'company' | 'teamSize' | 'message'

function line(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.length < 1 || s.length > max || CONTROL_RE.test(s)) return null
  return s
}

// The Enterprise "Contact sales" form on the marketing site. Public: no account needed.
export const contact = new Hono()

contact.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return c.json({ error: 'Send the form as JSON.' }, 400)

  const bad = (field: Field, error: string) => c.json({ error, field }, 400)

  // A field people can't see: bots fill it in, and they get the same answer as everyone else
  if (typeof body.website === 'string' && body.website.trim() !== '') return c.body(null, 204)

  const name = line(body.name, 100)
  if (!name) return bad('name', 'Enter your name, up to 100 characters.')
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || !EMAIL_RE.test(email) || CONTROL_RE.test(email)) return bad('email', 'Enter a valid work email address.')
  const company = line(body.company, 120)
  if (!company) return bad('company', 'Enter your company, up to 120 characters.')
  const teamSize = TEAM_SIZES.find((s) => s === body.teamSize)
  if (!teamSize) return bad('teamSize', 'Choose your team size.')
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (message.length < 10 || message.length > 5000) return bad('message', 'Tell us a little more: 10 to 5,000 characters.')
  const topic = TOPICS[typeof body.topic === 'string' ? body.topic : ''] ?? TOPICS.enterprise

  if (!allow(email)) return c.json({ error: 'We already have a few messages from this address. We will reply soon.' }, 429)

  try {
    await sendSalesInquiry({ name, email, company, teamSize, topic, message })
  } catch (err) {
    console.error('Sending sales inquiry failed', err)
    return c.json({ error: 'Your message could not be sent. Try again in a moment.' }, 502)
  }
  return c.body(null, 204)
})
