import { Hono } from 'hono'
import { securityLog } from '../audit.js'
import type { AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { enterprise, graceEndsAt, licenseStatus, parseLicense, seatsInUse } from '../license.js'

// The license key of a self-hosted install, under /api/admin/license (admins only, from admin.ts).
// The hosted service has none, so it answers 404 there.
export const license = new Hono<AuthEnv>()

license.use(async (c, next) => {
  if (!env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  await next()
})

const longDate = (d: Date) => d.toLocaleDateString('en', { dateStyle: 'long', timeZone: 'UTC' })

async function describe() {
  const state = await enterprise()
  const l = state.license
  return {
    status: state.status,
    invalid: state.invalid,
    license: l
      ? {
          id: l.id,
          customer: l.customer,
          email: l.email,
          seats: l.seats,
          issuedAt: l.issuedAt.toISOString(),
          expiresAt: l.expiresAt.toISOString(),
          graceEndsAt: graceEndsAt(l).toISOString(),
        }
      : null,
    seatsInUse: await seatsInUse(),
  }
}

license.get('/', async (c) => c.json(await describe()))

// { key } adds or replaces the key
license.put('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null
  const key = typeof body?.key === 'string' ? body.key.replace(/\s+/g, '') : ''
  if (!key) return c.json({ error: 'Paste the license key.', field: 'key' }, 400)
  const parsed = parseLicense(key)
  if (!parsed.ok) return c.json({ error: parsed.error, field: 'key' }, 400)
  if (licenseStatus(parsed.license) !== 'active') {
    return c.json({ error: `This license key expired on ${longDate(parsed.license.expiresAt)}. Ask for a new license key.`, field: 'key' }, 400)
  }
  const set = { licenseKey: key, licenseUpdatedBy: c.get('user')!.id, licenseUpdatedAt: new Date() }
  // Without a settings row yet, sign-up stays open, which is what having no row means
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, signupPolicy: 'open', ...set })
    .onConflictDoUpdate({ target: schema.instanceSettings.id, set })
  securityLog('license.changed', {
    actorId: c.get('user')!.id,
    targetId: parsed.license.id,
    customer: parsed.license.customer,
    expiresAt: parsed.license.expiresAt.toISOString(),
  })
  return c.json(await describe())
})

// Enterprise features turn off; nothing else changes
license.delete('/', async (c) => {
  const set = { licenseKey: null, licenseUpdatedBy: c.get('user')!.id, licenseUpdatedAt: new Date() }
  await db.update(schema.instanceSettings).set(set)
  securityLog('license.removed', { actorId: c.get('user')!.id, targetId: null })
  return c.json(await describe())
})
