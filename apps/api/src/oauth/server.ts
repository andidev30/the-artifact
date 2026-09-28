import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { blockedOrganizations, twoFactorRequiredError } from '../auth/factors.js'
import { hashToken, randomToken } from '../auth/session.js'
import { track } from '../analytics.js'
import { db, schema } from '../db/index.js'
import { env } from '../env.js'
import { clientIp, hit, tooManyRequests, waitText } from '../limits.js'
import { authenticateToken, TOKEN_RE } from '../tokens.js'
import { hasControlChars } from '../validation.js'

// OAuth 2.1 authorization server for MCP clients, following the MCP authorization spec:
// discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591), and
// authorization code with PKCE. Clients are public (no secret).

export const MCP_RESOURCE = `${env.appUrl}/mcp`
export const RESOURCE_METADATA_URL = `${env.appUrl}/.well-known/oauth-protected-resource/mcp`
const SCOPE = 'artifacts'

const GRANT_TTL = 10 * 60 * 1000
const ACCESS_TTL = 60 * 60 * 1000
const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000

export const oauth = new Hono()

function protectedResource(c: Context) {
  return c.json({
    resource: MCP_RESOURCE,
    authorization_servers: [env.appUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
  })
}

oauth.get('/.well-known/oauth-protected-resource', protectedResource)
oauth.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

oauth.get('/.well-known/oauth-authorization-server', (c) =>
  c.json({
    issuer: env.appUrl,
    authorization_endpoint: `${env.appUrl}/oauth/authorize`,
    token_endpoint: `${env.appUrl}/oauth/token`,
    registration_endpoint: `${env.appUrl}/oauth/register`,
    revocation_endpoint: `${env.appUrl}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  }),
)

// Loopback redirects (native CLIs), https, or an app's own scheme (cursor://...)
export function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'vbscript:', 'data:', 'file:', 'blob:', 'about:'].includes(url.protocol)
  } catch {
    return false
  }
}

oauth.post('/oauth/register', async (c) => {
  const ip = clientIp(c)
  const wait = ip ? await hit('oauth-register-ip', ip) : null
  if (wait) {
    // error_description too, which is what OAuth clients show
    const error = `Too many agents were connected from your network. Try again in ${waitText(wait)}.`
    return tooManyRequests(c, error, wait, { error_description: error })
  }
  const body = (await c.req.json().catch(() => null)) as { client_name?: unknown; redirect_uris?: unknown } | null
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirect)) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'Provide at least one https, loopback or app-scheme redirect URI.' }, 400)
  }
  const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'MCP client'
  if (hasControlChars(name)) return c.json({ error: 'invalid_client_metadata', error_description: "client_name can't contain control characters." }, 400)
  const id = randomToken()
  await db.insert(schema.oauthClients).values({ id, name, redirectUris })
  return c.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    201,
  )
})

// Loopback clients may pick a different port each run (RFC 8252 §7.3)
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  try {
    const req = new URL(requested)
    if (req.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return false
    return registered.some((r) => {
      const reg = new URL(r)
      return reg.protocol === req.protocol && reg.hostname === req.hostname && reg.pathname === req.pathname
    })
  } catch {
    return false
  }
}

// Client ids are randomToken()s; anything else is an unknown client without asking the database
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
// RFC 6749: state is printable ASCII. RFC 7636: an S256 challenge is 43 base64url characters.
const STATE_RE = /^[\x20-\x7e]+$/
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

function authorizeError(message: string) {
  const url = new URL('/authorize', env.appUrl)
  url.searchParams.set('error', message)
  return url.toString()
}

oauth.get('/oauth/authorize', async (c) => {
  const q = c.req.query()
  const [client] =
    q.client_id && CLIENT_ID_RE.test(q.client_id) ? await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, q.client_id)) : []
  // Without a trusted redirect URI we can't send errors back to the client, so show them here
  if (!client) return c.redirect(authorizeError('unknown_client'))
  if (!q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri)) return c.redirect(authorizeError('bad_redirect'))

  const back = new URL(q.redirect_uri)
  if (q.state && !STATE_RE.test(q.state)) {
    back.searchParams.set('error', 'invalid_request')
    back.searchParams.set('error_description', 'state must be printable ASCII.')
    return c.redirect(back.toString())
  }
  if (q.state) back.searchParams.set('state', q.state)
  if (q.response_type !== 'code') {
    back.searchParams.set('error', 'unsupported_response_type')
    return c.redirect(back.toString())
  }
  if (!q.code_challenge || q.code_challenge_method !== 'S256' || !CHALLENGE_RE.test(q.code_challenge)) {
    back.searchParams.set('error', 'invalid_request')
    back.searchParams.set('error_description', 'PKCE with S256 is required.')
    return c.redirect(back.toString())
  }

  const id = randomToken()
  await db.insert(schema.oauthGrants).values({
    id,
    clientId: client.id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    state: q.state ?? null,
    expiresAt: new Date(Date.now() + GRANT_TTL),
  })
  const consent = new URL('/authorize', env.appUrl)
  consent.searchParams.set('request', id)
  return c.redirect(consent.toString())
})

async function issueTokens(clientId: string, userId: string, organizationId: string | null) {
  const access = randomToken()
  const refresh = randomToken()
  await db.insert(schema.oauthTokens).values([
    { id: hashToken(access), kind: 'access', clientId, userId, organizationId, expiresAt: new Date(Date.now() + ACCESS_TTL) },
    { id: hashToken(refresh), kind: 'refresh', clientId, userId, organizationId, expiresAt: new Date(Date.now() + REFRESH_TTL) },
  ])
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refresh,
    scope: SCOPE,
  }
}

// S256: the challenge is the base64url SHA-256 of the verifier (RFC 7636)
export function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

function tokenError(c: Context, error: string, description: string) {
  return c.json({ error, error_description: description }, 400)
}

// Why this person can no longer act in this workspace, or null when they can: they left or were
// removed from the organization, or it requires a second factor they haven't set up
export async function workspaceRefusal(userId: string, organizationId: string | null): Promise<string | null> {
  if (!organizationId) return null
  const [member] = await db
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, organizationId)))
  if (!member) return 'You are not in this organization any more.'
  if ((await blockedOrganizations(userId)).includes(organizationId)) return (await twoFactorRequiredError(organizationId)).error
  return null
}

// Ends a connection: every token one client holds for one person, as Disconnect in settings does
async function endConnection(clientId: string, userId: string) {
  await db.delete(schema.oauthTokens).where(and(eq(schema.oauthTokens.clientId, clientId), eq(schema.oauthTokens.userId, userId)))
}

oauth.post('/oauth/token', async (c) => {
  const type = c.req.header('content-type') ?? ''
  const params: Record<string, string> = type.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]))

  if (params.grant_type === 'authorization_code') {
    if (!params.code || !params.code_verifier) return tokenError(c, 'invalid_request', 'code and code_verifier are required.')
    // Codes work once: remove the grant as it is read
    const [grant] = await db
      .delete(schema.oauthGrants)
      .where(eq(schema.oauthGrants.code, hashToken(params.code)))
      .returning()
    if (!grant?.userId || grant.expiresAt.getTime() < Date.now()) return tokenError(c, 'invalid_grant', 'The authorization code is invalid or expired.')
    if (params.client_id && params.client_id !== grant.clientId) return tokenError(c, 'invalid_grant', 'The code was issued to another client.')
    if (params.redirect_uri && params.redirect_uri !== grant.redirectUri) return tokenError(c, 'invalid_grant', 'redirect_uri does not match.')
    if (!pkceMatches(params.code_verifier, grant.codeChallenge)) return tokenError(c, 'invalid_grant', 'PKCE verification failed.')
    // Approved for an organization, then removed from it before the code was exchanged
    const refused = await workspaceRefusal(grant.userId, grant.organizationId)
    if (refused) return tokenError(c, 'invalid_grant', refused)
    const tokens = await issueTokens(grant.clientId, grant.userId, grant.organizationId)
    track({ event: 'agent_connected', userId: grant.userId, detail: 'oauth' })
    return c.json(tokens)
  }

  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) return tokenError(c, 'invalid_request', 'refresh_token is required.')
    const where = and(eq(schema.oauthTokens.id, hashToken(params.refresh_token)), eq(schema.oauthTokens.kind, 'refresh'))
    // Check the client before using the token up, so a wrong client can't burn someone else's token
    const [found] = await db.select().from(schema.oauthTokens).where(where)
    if (!found || found.expiresAt.getTime() < Date.now()) return tokenError(c, 'invalid_grant', 'The refresh token is invalid or expired.')
    if (params.client_id && params.client_id !== found.clientId) return tokenError(c, 'invalid_grant', 'The token was issued to another client.')
    // Refused without using the token up, so it works again once a missing second factor is added
    const refused = found.usedAt ? null : await workspaceRefusal(found.userId, found.organizationId)
    if (refused) return tokenError(c, 'invalid_grant', refused)
    // Refresh tokens rotate and the used one is kept. Seeing it again means two parties hold the
    // connection, and there is no telling which is the client, so it ends for both (OAuth 2.1, section 4.3.1).
    const [old] = await db
      .update(schema.oauthTokens)
      .set({ usedAt: new Date() })
      .where(and(where, isNull(schema.oauthTokens.usedAt)))
      .returning()
    if (!old) {
      await endConnection(found.clientId, found.userId)
      return tokenError(c, 'invalid_grant', 'The refresh token was already used. Connect again.')
    }
    return c.json(await issueTokens(old.clientId, old.userId, old.organizationId))
  }

  return tokenError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
})

// Token revocation (RFC 7009), for clients that sign out, like the CLI's logout. Revoking either
// token of a connection ends the whole connection, as Disconnect does in settings. The answer is
// 200 whether or not the token was known, so it reveals nothing.
oauth.post('/oauth/revoke', async (c) => {
  const type = c.req.header('content-type') ?? ''
  const params: Record<string, unknown> = type.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))
  if (typeof params.token !== 'string' || !params.token) return tokenError(c, 'invalid_request', 'token is required.')
  const [found] = await db
    .select({ clientId: schema.oauthTokens.clientId, userId: schema.oauthTokens.userId })
    .from(schema.oauthTokens)
    .where(eq(schema.oauthTokens.id, hashToken(params.token)))
  if (found && (!params.client_id || params.client_id === found.clientId)) await endConnection(found.clientId, found.userId)
  return c.body(null, 200)
})

export type McpAuth = {
  userId: string
  email: string
  organizationId: string | null
  clientName: string
  // Organizations that require a second factor this person hasn't set up. The token's own workspace
  // is never one of them (the token is refused then); pages in the others stay closed to it.
  blockedOrgs: string[]
}

// Resolves a bearer token, an OAuth access token or an access token from settings (src/tokens.ts),
// to the person and workspace it acts for. Like access tokens, OAuth tokens are checked against
// suspension and membership on every request.
export async function authenticateBearer(header: string | undefined): Promise<McpAuth | null> {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) return null
  // OAuth tokens are 43 characters, so they never match
  if (TOKEN_RE.test(token)) return authenticateToken(token)
  const [row] = await db
    .select({
      token: schema.oauthTokens,
      clientName: schema.oauthClients.name,
      email: schema.users.email,
      suspendedAt: schema.users.suspendedAt,
      role: schema.memberships.role,
    })
    .from(schema.oauthTokens)
    .innerJoin(schema.oauthClients, eq(schema.oauthTokens.clientId, schema.oauthClients.id))
    .innerJoin(schema.users, eq(schema.oauthTokens.userId, schema.users.id))
    .leftJoin(
      schema.memberships,
      and(eq(schema.memberships.userId, schema.oauthTokens.userId), eq(schema.memberships.organizationId, schema.oauthTokens.organizationId)),
    )
    .where(and(eq(schema.oauthTokens.id, hashToken(token)), eq(schema.oauthTokens.kind, 'access')))
  if (!row || row.token.expiresAt.getTime() < Date.now() || row.suspendedAt) return null
  if (row.token.organizationId && !row.role) return null
  const blockedOrgs = await blockedOrganizations(row.token.userId)
  if (row.token.organizationId && blockedOrgs.includes(row.token.organizationId)) return null
  await db.update(schema.oauthTokens).set({ lastUsedAt: new Date() }).where(eq(schema.oauthTokens.id, row.token.id))
  return { userId: row.token.userId, email: row.email, organizationId: row.token.organizationId, clientName: row.clientName, blockedOrgs }
}
