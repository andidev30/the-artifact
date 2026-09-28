import { and, eq, isNotNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

// A second factor is a passkey or a confirmed authenticator app. Recovery codes only stand in for one.
export async function hasSecondFactor(userId: string): Promise<boolean> {
  const [passkey] = await db.select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).limit(1)
  if (passkey) return true
  const [totp] = await db
    .select({ userId: schema.totpSecrets.userId })
    .from(schema.totpSecrets)
    .where(and(eq(schema.totpSecrets.userId, userId), isNotNull(schema.totpSecrets.confirmedAt)))
  return Boolean(totp)
}

// Organizations of this person that require two-factor sign-in
export async function organizationsRequiringFactor(userId: string) {
  return db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.memberships)
    .innerJoin(schema.organizations, eq(schema.memberships.organizationId, schema.organizations.id))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.organizations.requireTwoFactor, true)))
    .orderBy(schema.memberships.createdAt)
}

// The organizations this person can't use in the web app until they set up a second factor. Their
// agents and access tokens keep working there (see docs/security.md).
export async function blockedOrganizations(userId: string): Promise<string[]> {
  const required = await organizationsRequiringFactor(userId)
  if (!required.length || (await hasSecondFactor(userId))) return []
  return required.map((o) => o.id)
}

// What to answer when someone tries to use an organization they are blocked from
export async function twoFactorRequiredError(organizationId: string) {
  const [org] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, organizationId))
  const name = org?.name ?? 'This organization'
  return {
    error: `${name} requires two-factor sign-in. Add a passkey or an authenticator app in your account settings to use it.`,
    code: 'two_factor_required',
  }
}
