import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { count, eq, isNull } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { db, schema } from './db/index.js'
import { env } from './env.js'

// License keys for self-hosted installs, checked offline: nothing here makes a request, so an
// install without internet access checks a key the same way. A key is
//
//   art_lic_<base64url(JSON payload)>.<base64url(Ed25519 signature)>
//
// signed over everything before the dot. The hosted service signs keys (src/ee/licenses.ts);
// this file only verifies them, because self-hosted installs need it.

export const LICENSE_PREFIX = 'art_lic_'
export const LICENSE_FORMAT = 1
export const GRACE_DAYS = 14
const DAY = 24 * 60 * 60 * 1000

// Public keys that sign license keys, by key id (licenseKeyId of the public key). Keep old keys in
// the list after a rotation so keys they signed keep working until they expire. Add one with
// `pnpm --filter @the-artifact/api license:keygen` (see docs/licenses.md).
export const LICENSE_PUBLIC_KEYS: Record<string, string> = {
  // The hosted service's first signing key, made 2026-09-28
  L3QcVWmRQLfb: 'esNEzdgObEdUmR5aFVyBmtYQqZVN6cbbq+0/6TQAUds=',
}

export type LicensePayload = {
  v: number
  // Signing key id
  kid: string
  // License id, as in issued_licenses on the hosted service
  id: string
  customer: string
  email: string
  seats: number
  issuedAt: string
  expiresAt: string
}

export type License = {
  id: string
  signingKeyId: string
  customer: string
  email: string
  seats: number
  issuedAt: Date
  expiresAt: Date
}

export type LicenseStatus = 'none' | 'active' | 'grace' | 'expired'

// A short, stable id for an Ed25519 public key given as base64 of its 32 raw bytes
export function licenseKeyId(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url').slice(0, 12)
}

export function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }, format: 'jwk' })
}

type Parsed = { ok: true; license: License } | { ok: false; error: string }

const MALFORMED = 'This is not a license key. A license key starts with art_lic_. Paste the whole key.'
const TAMPERED = 'This license key has been changed or is incomplete. Paste the whole key again, exactly as you received it.'
const UNKNOWN_SIGNER = 'This license key was signed by a key this version doesn’t know. Update the server, or ask for a new license key.'

// Checks the signature and the fields; says nothing about expiry (see licenseStatus). People paste
// keys from email, so whitespace and line breaks anywhere are ignored.
export function parseLicense(input: string, publicKeys: Record<string, string> = LICENSE_PUBLIC_KEYS): Parsed {
  const key = input.replace(/\s+/g, '')
  if (!key.startsWith(LICENSE_PREFIX)) return { ok: false, error: MALFORMED }
  const parts = key.slice(LICENSE_PREFIX.length).split('.')
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, error: MALFORMED }
  const [body, signature] = parts

  let payload: Partial<LicensePayload>
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, error: TAMPERED }
  }
  if (!payload || typeof payload !== 'object') return { ok: false, error: TAMPERED }
  if (payload.v !== LICENSE_FORMAT) return { ok: false, error: 'This license key is for a different version. Update the server, or ask for a new license key.' }

  const publicKey = typeof payload.kid === 'string' && Object.hasOwn(publicKeys, payload.kid) ? publicKeys[payload.kid] : null
  if (!publicKey) return { ok: false, error: UNKNOWN_SIGNER }
  let valid = false
  try {
    valid = verify(null, Buffer.from(LICENSE_PREFIX + body), publicKeyObject(publicKey), Buffer.from(signature, 'base64url'))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, error: TAMPERED }

  const issuedAt = new Date(payload.issuedAt ?? '')
  const expiresAt = new Date(payload.expiresAt ?? '')
  if (
    typeof payload.id !== 'string' ||
    typeof payload.customer !== 'string' ||
    typeof payload.email !== 'string' ||
    !Number.isSafeInteger(payload.seats) ||
    (payload.seats as number) < 1 ||
    Number.isNaN(issuedAt.getTime()) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return { ok: false, error: TAMPERED }
  }
  return {
    ok: true,
    license: {
      id: payload.id,
      signingKeyId: payload.kid as string,
      customer: payload.customer,
      email: payload.email,
      seats: payload.seats as number,
      issuedAt,
      expiresAt,
    },
  }
}

export function graceEndsAt(license: Pick<License, 'expiresAt'>): Date {
  return new Date(license.expiresAt.getTime() + GRACE_DAYS * DAY)
}

// Active until expiresAt, then a grace period with a warning, then expired. Nothing is deleted when
// it expires; only enterprise features turn off.
export function licenseStatus(license: Pick<License, 'expiresAt'> | null, now = new Date()): LicenseStatus {
  if (!license) return 'none'
  if (now < license.expiresAt) return 'active'
  if (now < graceEndsAt(license)) return 'grace'
  return 'expired'
}

export type EnterpriseState = {
  status: LicenseStatus
  license: License | null
  // A key is stored but no longer checks out, e.g. its signing key was removed from the code
  invalid: string | null
}

// The license of this install, read and verified on every call so a key edited in the database
// or signed by a key removed from the code never counts
export async function enterprise(now = new Date()): Promise<EnterpriseState> {
  // The hosted service doesn't turn enterprise features on through a license key; its Enterprise
  // plan will turn them on per organization when it exists.
  if (!env.selfHosted) return { status: 'none', license: null, invalid: null }
  const [row] = await db.select({ key: schema.instanceSettings.licenseKey }).from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1))
  if (!row?.key) return { status: 'none', license: null, invalid: null }
  const parsed = parseLicense(row.key)
  if (!parsed.ok) return { status: 'none', license: null, invalid: parsed.error }
  return { status: licenseStatus(parsed.license, now), license: parsed.license, invalid: null }
}

// The gate for enterprise features (audit log, SSO and the rest): on while the license is active
// and during the grace period after it expires
export async function hasEnterprise(now = new Date()): Promise<boolean> {
  const { status } = await enterprise(now)
  return status === 'active' || status === 'grace'
}

export const enterpriseRequired = {
  error: 'This needs an Enterprise license. An instance admin can add one under Server admin.',
  code: 'enterprise_required',
}

// For routes of an enterprise feature: answers 403 while the install has no license that counts
export const requireEnterprise = createMiddleware(async (c, next) => {
  if (!(await hasEnterprise())) return c.json(enterpriseRequired, 403)
  await next()
})

// People who count against the seats: every account that isn't suspended
export async function seatsInUse(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.users).where(isNull(schema.users.suspendedAt))
  return row.n
}
