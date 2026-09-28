import { and, desc, eq, sql } from 'drizzle-orm'
import { hashToken, randomToken } from './auth/session.js'
import { db, schema } from './db/index.js'
import type { McpAuth } from './oauth/server.js'

// Access tokens: made in account settings for CI and scripts, used as a bearer token on /mcp and
// POST /api/publish. Each acts for one person in one workspace, like an OAuth connection, and is
// checked against the database on every request, so revoking one stops it at once.

// Recognizable by secret scanners (GitHub's, gitleaks...), and by authenticateBearer
export const TOKEN_PREFIX = 'art_'
export const TOKEN_RE = /^art_[A-Za-z0-9_-]{43}$/
export const EXPIRY_DAYS = [7, 30, 90, 365] as const
export const DEFAULT_EXPIRY_DAYS = 90
export const MAX_TOKEN_NAME = 60

const DAY = 24 * 60 * 60 * 1000
// How stale last_used_at may get, so a busy token doesn't write on every request
const USED_EVERY = 60 * 1000

export function newToken(): string {
  return `${TOKEN_PREFIX}${randomToken()}`
}

export function checkTokenName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 1 || name.length > MAX_TOKEN_NAME) return { error: `Use 1 to ${MAX_TOKEN_NAME} characters for the name.` }
  return { name }
}

// null is "no expiry"; undefined takes the default
export function checkExpiry(value: unknown): { expiresAt: Date | null } | { error: string } {
  if (value === null) return { expiresAt: null }
  const days = value === undefined ? DEFAULT_EXPIRY_DAYS : value
  if (!EXPIRY_DAYS.includes(days as (typeof EXPIRY_DAYS)[number])) {
    return { error: `Choose ${EXPIRY_DAYS.join(', ')} days, or no expiry.` }
  }
  return { expiresAt: new Date(Date.now() + (days as number) * DAY) }
}

export async function createToken(input: { userId: string; organizationId: string | null; name: string; expiresAt: Date | null }) {
  const token = newToken()
  const [row] = await db
    .insert(schema.accessTokens)
    .values({ ...input, tokenHash: hashToken(token) })
    .returning()
  return { token, row }
}

// The person and workspace a token acts for, or null when it is unknown, expired, belongs to a
// suspended account, or is for an organization the person is no longer in
export async function authenticateToken(token: string): Promise<McpAuth | null> {
  if (!TOKEN_RE.test(token)) return null
  const [row] = await db
    .select({ token: schema.accessTokens, email: schema.users.email, suspendedAt: schema.users.suspendedAt, role: schema.memberships.role })
    .from(schema.accessTokens)
    .innerJoin(schema.users, eq(schema.accessTokens.userId, schema.users.id))
    .leftJoin(
      schema.memberships,
      and(eq(schema.memberships.userId, schema.accessTokens.userId), eq(schema.memberships.organizationId, schema.accessTokens.organizationId)),
    )
    .where(eq(schema.accessTokens.tokenHash, hashToken(token)))
  if (!row || row.suspendedAt) return null
  const t = row.token
  if (t.expiresAt && t.expiresAt.getTime() <= Date.now()) return null
  if (t.organizationId && !row.role) return null
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > USED_EVERY) {
    await db.update(schema.accessTokens).set({ lastUsedAt: sql`now()` }).where(eq(schema.accessTokens.id, t.id))
  }
  return { userId: t.userId, email: row.email, organizationId: t.organizationId, clientName: t.name }
}

const listed = {
  id: schema.accessTokens.id,
  name: schema.accessTokens.name,
  organizationId: schema.accessTokens.organizationId,
  organizationName: schema.organizations.name,
  createdAt: schema.accessTokens.createdAt,
  lastUsedAt: schema.accessTokens.lastUsedAt,
  expiresAt: schema.accessTokens.expiresAt,
}

type ListedRow = {
  id: string
  name: string
  organizationId: string | null
  organizationName: string | null
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}

// What settings show; never the token or its hash
function describe(r: ListedRow) {
  return {
    id: r.id,
    name: r.name,
    workspace: { id: r.organizationId, name: r.organizationName ?? 'Personal' },
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    expired: r.expiresAt !== null && r.expiresAt.getTime() <= Date.now(),
  }
}

export type ListedToken = ReturnType<typeof describe>

export async function describeToken(id: string): Promise<ListedToken> {
  const [row] = await db
    .select(listed)
    .from(schema.accessTokens)
    .leftJoin(schema.organizations, eq(schema.accessTokens.organizationId, schema.organizations.id))
    .where(eq(schema.accessTokens.id, id))
  return describe(row)
}

// A person's tokens, in every workspace. Tokens for organizations they left were deleted then.
export async function tokensOf(userId: string): Promise<ListedToken[]> {
  const rows = await db
    .select(listed)
    .from(schema.accessTokens)
    .leftJoin(schema.organizations, eq(schema.accessTokens.organizationId, schema.organizations.id))
    .where(eq(schema.accessTokens.userId, userId))
    .orderBy(desc(schema.accessTokens.createdAt))
  return rows.map(describe)
}

// Every member's tokens for one organization, for its owners and admins
export async function tokensIn(organizationId: string) {
  const rows = await db
    .select({ ...listed, ownerId: schema.users.id, ownerName: schema.users.name, ownerEmail: schema.users.email })
    .from(schema.accessTokens)
    .innerJoin(schema.users, eq(schema.accessTokens.userId, schema.users.id))
    .leftJoin(schema.organizations, eq(schema.accessTokens.organizationId, schema.organizations.id))
    .where(eq(schema.accessTokens.organizationId, organizationId))
    .orderBy(desc(schema.accessTokens.createdAt))
  return rows.map((r) => ({ ...describe(r), owner: { id: r.ownerId, name: r.ownerName, email: r.ownerEmail } }))
}

// Whether a token was deleted; `where` narrows it to one person's or one organization's tokens
export async function revokeToken(id: string, where: { userId: string } | { organizationId: string }): Promise<boolean> {
  const scope = 'userId' in where ? eq(schema.accessTokens.userId, where.userId) : eq(schema.accessTokens.organizationId, where.organizationId)
  const rows = await db
    .delete(schema.accessTokens)
    .where(and(eq(schema.accessTokens.id, id), scope))
    .returning({ id: schema.accessTokens.id })
  return rows.length > 0
}
