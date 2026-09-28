import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/session.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { isInstanceAdmin } from '../instance.js'
import { LICENSE_FORMAT, LICENSE_PREFIX, LICENSE_PUBLIC_KEYS, licenseKeyId, type LicensePayload } from '../license.js'
import { EMAIL_RE } from '../validation.js'

// Issuing license keys for self-hosted installs, on the hosted service only. The key is signed with
// LICENSE_SIGNING_KEY; installs check it offline against LICENSE_PUBLIC_KEYS in src/license.ts.

export type SigningKey = { privateKey: KeyObject; keyId: string; publicKey: string }

// LICENSE_SIGNING_KEY is an Ed25519 private key: base64 of its PKCS#8 DER (one line, as
// `license:keygen` prints it) or a PEM block
export function readSigningKey(value: string): SigningKey | null {
  const v = value.trim()
  if (!v) return null
  try {
    const privateKey = v.startsWith('-----')
      ? createPrivateKey(v.replace(/\\n/g, '\n'))
      : createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'ed25519') return null
    const x = createPublicKey(privateKey).export({ format: 'jwk' }).x as string
    const publicKey = Buffer.from(x, 'base64url').toString('base64')
    return { privateKey, keyId: licenseKeyId(publicKey), publicKey }
  } catch {
    return null
  }
}

export function signLicense(fields: Omit<LicensePayload, 'v' | 'kid'>, key: SigningKey): string {
  const payload: LicensePayload = { v: LICENSE_FORMAT, kid: key.keyId, ...fields }
  const signed = LICENSE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${signed}.${sign(null, Buffer.from(signed), key.privateKey).toString('base64url')}`
}

// The signing key, or why keys can't be issued, in words for the admin page
export function signingKey(): { ok: true; key: SigningKey } | { ok: false; reason: string } {
  if (!env.licenseSigningKey) return { ok: false, reason: 'This server has no signing key. Set LICENSE_SIGNING_KEY to issue license keys.' }
  const key = readSigningKey(env.licenseSigningKey)
  if (!key) return { ok: false, reason: 'LICENSE_SIGNING_KEY is not an Ed25519 private key. Make one with license:keygen.' }
  // A key the code doesn't list would be rejected by every install, so don't hand it out
  if (LICENSE_PUBLIC_KEYS[key.keyId] !== key.publicKey) {
    return { ok: false, reason: `The public key of LICENSE_SIGNING_KEY (id ${key.keyId}) is not in LICENSE_PUBLIC_KEYS, so installs would reject its keys.` }
  }
  return { ok: true, key }
}

export const issuedLicenses = new Hono<AuthEnv>()

issuedLicenses.use(async (c, next) => {
  if (env.selfHosted) return c.json({ error: 'Not found.' }, 404)
  const user = c.get('user')
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
  if (!isInstanceAdmin(user)) return c.json({ error: 'Only instance admins can open this.', code: 'not_admin' }, 403)
  await next()
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function describe(row: typeof schema.issuedLicenses.$inferSelect, issuer: string | null) {
  return {
    id: row.id,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    seats: row.seats,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    issuedBy: issuer,
  }
}

issuedLicenses.get('/', async (c) => {
  const key = signingKey()
  const rows = await db
    .select({ row: schema.issuedLicenses, issuer: schema.users.email })
    .from(schema.issuedLicenses)
    .leftJoin(schema.users, eq(schema.issuedLicenses.issuedBy, schema.users.id))
    .orderBy(desc(schema.issuedLicenses.issuedAt))
    .limit(200)
  return c.json({
    available: key.ok,
    reason: key.ok ? null : key.reason,
    licenses: rows.map((r) => describe(r.row, r.issuer)),
  })
})

// { customerName, customerEmail, seats, expiresOn: 'YYYY-MM-DD' } → the key, shown once
issuedLicenses.post('/', async (c) => {
  const key = signingKey()
  if (!key.ok) return c.json({ error: key.reason }, 409)
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>

  const customerName = typeof b.customerName === 'string' ? b.customerName.trim().replace(/\s+/g, ' ') : ''
  if (!customerName) return c.json({ error: 'Enter who the license is for.', field: 'customerName' }, 400)
  if (customerName.length > 200) return c.json({ error: 'Use at most 200 characters for the name.', field: 'customerName' }, 400)
  const customerEmail = typeof b.customerEmail === 'string' ? b.customerEmail.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(customerEmail) || customerEmail.length > 254)
    return c.json({ error: 'Enter an email address like name@example.com.', field: 'customerEmail' }, 400)
  const seats = Number(b.seats)
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 1_000_000)
    return c.json({ error: 'Enter a whole number of seats, at least 1.', field: 'seats' }, 400)

  const issuedAt = new Date()
  const day = typeof b.expiresOn === 'string' && DATE_RE.test(b.expiresOn) ? new Date(`${b.expiresOn}T23:59:59.999Z`) : null
  if (!day || Number.isNaN(day.getTime())) return c.json({ error: 'Choose the last day the license is valid.', field: 'expiresOn' }, 400)
  if (day <= issuedAt) return c.json({ error: 'Choose a day after today.', field: 'expiresOn' }, 400)

  const id = randomUUID()
  const licenseKey = signLicense(
    { id, customer: customerName, email: customerEmail, seats, issuedAt: issuedAt.toISOString(), expiresAt: day.toISOString() },
    key.key,
  )
  const actor = c.get('user')!
  const [row] = await db
    .insert(schema.issuedLicenses)
    .values({ id, signingKeyId: key.key.keyId, customerName, customerEmail, seats, issuedAt, expiresAt: day, issuedBy: actor.id })
    .returning()
  return c.json({ key: licenseKey, license: describe(row, actor.email) }, 201)
})
