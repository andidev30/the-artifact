import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import type { SsoConnection, User } from '../../db/schema.js'
import { env, isProduction } from '../../env.js'
import { DOMAIN_RE, isInstanceAdmin } from '../../instance.js'
import { hasEnterprise } from '../../license.js'
import { seal, unseal } from '../../secrets.js'
import { UUID_RE } from '../../validation.js'

// Single sign-on connections, an Enterprise feature of self-hosted installs (see docs/sso.md).
//
// A connection is one row of sso_connections: an identity provider the instance admin set up, shown
// as one "Continue with <name>" button on the sign-in page. It is configured for the whole instance,
// not per organization: on a self-hosted install the instance admin is the one who controls the
// identity provider, and people who arrive through it land in the organization the connection names.
//
// `protocol` says how `config` reads. Only OIDC exists so far; SAML adds its own shape to SsoConfig
// and its own sign-in routes, and reuses the rest (domains, required, organization, sso_identities).

export type OidcConfig = {
  // Issuer URL; the settings come from <issuer>/.well-known/openid-configuration
  issuer: string
  clientId: string
  // Accept the provider's addresses without an email_verified claim. For providers that don't send
  // one (Microsoft Entra ID); only safe when the admin controls the addresses there.
  trustEmail: boolean
}

export type SsoConfig = { protocol: 'oidc'; oidc: OidcConfig }

// The server secret that seals connection secrets (client secrets) in sso_connections.secret
const SECRET_KEY = 'sso'

export const sealConnectionSecret = (secret: string) => seal(SECRET_KEY, Buffer.from(secret, 'utf8'))
export const openConnectionSecret = async (sealed: string) => (await unseal(SECRET_KEY, sealed)).toString('utf8')

export function oidcConfig(conn: SsoConnection): OidcConfig {
  const c = conn.config as Partial<OidcConfig>
  return { issuer: String(c.issuer ?? ''), clientId: String(c.clientId ?? ''), trustEmail: c.trustEmail === true }
}

// Where the provider sends people back. Built from APP_URL, never from the request's Host header,
// so a forged header can't point the flow elsewhere. Admins register it at the provider.
export const oidcRedirectUri = () => `${env.appUrl}/api/auth/sso/oidc/callback`

export async function findConnection(id: string): Promise<SsoConnection | null> {
  if (!UUID_RE.test(id)) return null
  const [row] = await db.select().from(schema.ssoConnections).where(eq(schema.ssoConnections.id, id))
  return row ?? null
}

// A connection people may sign in through right now: turned on, and the install has a license that counts
export async function usableConnection(id: string): Promise<SsoConnection | null> {
  const conn = await findConnection(id)
  if (!conn?.enabled || !(await hasEnterprise())) return null
  return conn
}

// The buttons on the sign-in page. Without a license there are none, and nothing else changes.
export async function ssoButtons(): Promise<{ id: string; name: string }[]> {
  if (!env.selfHosted) return []
  const rows = await db
    .select({ id: schema.ssoConnections.id, name: schema.ssoConnections.name })
    .from(schema.ssoConnections)
    .where(eq(schema.ssoConnections.enabled, true))
    .orderBy(schema.ssoConnections.createdAt)
  if (!rows.length || !(await hasEnterprise())) return []
  return rows
}

export const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? ''

export function coversDomain(conn: Pick<SsoConnection, 'allowedDomains'>, email: string): boolean {
  return conn.allowedDomains.length === 0 || conn.allowedDomains.includes(domainOf(email))
}

// Whether this person must sign in through SSO instead of a password, an email link, Google or a
// passkey: a required connection covers their address. Instance admins never must, so a broken
// identity provider can't lock the server's admins out (their break-glass way in). Called by core
// after the first factor has checked out, so it tells nothing to someone who doesn't have one.
export async function ssoRequiredFor(user: Pick<User, 'email' | 'isAdmin' | 'suspendedAt'>): Promise<boolean> {
  if (!env.selfHosted || isInstanceAdmin(user)) return false
  const required = await db
    .select({ allowedDomains: schema.ssoConnections.allowedDomains })
    .from(schema.ssoConnections)
    .where(and(eq(schema.ssoConnections.enabled, true), eq(schema.ssoConnections.required, true)))
  if (!required.some((conn) => coversDomain(conn, user.email))) return false
  // Without a license that counts, SSO is off, so nobody is held to it
  return hasEnterprise()
}

export const ssoRequiredError = {
  error: 'Your organization signs in through single sign-on. Use its button on the sign-in page.',
  code: 'sso_required',
}

export type ConnectionInput = {
  name: string
  issuer: string
  clientId: string
  // null keeps the stored secret
  clientSecret: string | null
  trustEmail: boolean
  allowedDomains: string[]
  required: boolean
  enabled: boolean
  organizationId: string | null
}

type Parsed = { ok: true; value: ConnectionInput } | { ok: false; error: string; field: string }

// The issuer as the provider names itself: https (plain http only while APP_URL is too, for local
// providers in development), no query or fragment, no trailing slash
export function parseIssuer(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction)) return null
  if (url.search || url.hash || url.username || url.password) return null
  return url.toString().replace(/\/$/, '')
}

// Validates what the admin form sends. `creating` makes the client secret required.
export function parseConnection(body: unknown, creating: boolean): Parsed {
  const b = (body ?? {}) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { ok: false, error: 'Name the provider, for example Okta.', field: 'name' }
  if (name.length > 40) return { ok: false, error: 'Use at most 40 characters for the name.', field: 'name' }

  const issuer = parseIssuer(b.issuer)
  if (!issuer) {
    return {
      ok: false,
      error: isProduction ? 'Enter the issuer URL, starting with https://.' : 'Enter the issuer URL, starting with https:// or http://.',
      field: 'issuer',
    }
  }
  const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : ''
  if (!clientId) return { ok: false, error: 'Enter the client ID from your provider.', field: 'clientId' }
  if (clientId.length > 500) return { ok: false, error: 'That client ID is too long.', field: 'clientId' }
  const secret = typeof b.clientSecret === 'string' ? b.clientSecret.trim() : ''
  if (creating && !secret) return { ok: false, error: 'Enter the client secret from your provider.', field: 'clientSecret' }
  if (secret.length > 2000) return { ok: false, error: 'That client secret is too long.', field: 'clientSecret' }

  const raw = Array.isArray(b.allowedDomains) ? b.allowedDomains : typeof b.allowedDomains === 'string' ? b.allowedDomains.split(/[\s,]+/) : []
  const domains: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'List domains like example.com.', field: 'allowedDomains' }
    const d = item.trim().toLowerCase().replace(/^@/, '')
    if (!d) continue
    if (!DOMAIN_RE.test(d)) return { ok: false, error: `${d} is not a domain. List domains like example.com.`, field: 'allowedDomains' }
    if (!domains.includes(d)) domains.push(d)
  }
  if (domains.length > 100) return { ok: false, error: 'List at most 100 domains.', field: 'allowedDomains' }

  const organizationId = typeof b.organizationId === 'string' && b.organizationId ? b.organizationId : null
  if (organizationId && !UUID_RE.test(organizationId)) return { ok: false, error: 'Choose an organization from the list.', field: 'organizationId' }

  return {
    ok: true,
    value: {
      name,
      issuer,
      clientId,
      clientSecret: secret || null,
      trustEmail: b.trustEmail === true,
      allowedDomains: domains,
      required: b.required === true,
      enabled: b.enabled === true,
      organizationId,
    },
  }
}

// What the admin page shows; never the secret
export function describeConnection(conn: SsoConnection) {
  const oidc = oidcConfig(conn)
  return {
    id: conn.id,
    protocol: conn.protocol,
    name: conn.name,
    enabled: conn.enabled,
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    hasClientSecret: Boolean(conn.secret),
    trustEmail: oidc.trustEmail,
    allowedDomains: conn.allowedDomains,
    required: conn.required,
    organizationId: conn.organizationId,
    createdAt: conn.createdAt.toISOString(),
    updatedAt: conn.updatedAt.toISOString(),
  }
}
