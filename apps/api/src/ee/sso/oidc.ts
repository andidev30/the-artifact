import * as client from 'openid-client'
import type { SsoConnection } from '../../db/schema.js'
import { log } from '../../log.js'
import { oidcConfig, oidcRedirectUri, openConnectionSecret, type OidcConfig } from './connections.js'
import { oidcFetch } from './idp-requests.js'

// OpenID Connect through openid-client (panva): discovery, the authorization code flow with PKCE,
// state and nonce, and the ID token's signature checked against the provider's JWKS
// (enableNonRepudiationChecks) on top of its iss, aud, exp and nonce. Nothing here is hand-rolled.

const SCOPE = 'openid email profile'
// Seconds for each request to the provider
const TIMEOUT = 10
// Every request to the provider goes only to addresses idpAddress allows
const FETCH = oidcFetch(TIMEOUT * 1000)
// Discovery is kept this long per connection, so a sign-in costs one request to the provider fewer
const CACHE_MS = 60 * 60 * 1000

export class OidcSetupError extends Error {}

// Reads <issuer>/.well-known/openid-configuration and makes a client for it. The issuer in the
// document must match the configured one exactly (openid-client checks), so a wrong URL fails here.
export async function discover(oidc: OidcConfig, clientSecret: string): Promise<client.Configuration> {
  const execute = [client.enableNonRepudiationChecks]
  // parseIssuer only lets http through while APP_URL is http too, i.e. in development
  if (new URL(oidc.issuer).protocol === 'http:') execute.push(client.allowInsecureRequests)
  let discovered: client.Configuration
  try {
    discovered = await client.discovery(new URL(oidc.issuer), oidc.clientId, { client_secret: clientSecret }, undefined, {
      execute,
      timeout: TIMEOUT,
      [client.customFetch]: FETCH,
    })
  } catch (err) {
    // The reason stays in the log: shown to the admin, it would tell which private hosts and ports answer
    log.warn('OIDC discovery failed', { issuer: oidc.issuer, reason: oidcErrorText(err) })
    throw new OidcSetupError(`The provider’s settings could not be read from ${oidc.issuer}/.well-known/openid-configuration. Check the issuer URL.`)
  }
  const metadata = discovered.serverMetadata()
  if (metadata.response_types_supported && !metadata.response_types_supported.includes('code')) {
    throw new OidcSetupError('This provider doesn’t offer the authorization code flow, which sign-in needs.')
  }
  // Client secret basic is the default of the spec and what most providers expect; fall back to
  // sending the secret in the body only when the provider says basic isn't supported
  const methods = metadata.token_endpoint_auth_methods_supported
  const auth = !methods || methods.includes('client_secret_basic') ? client.ClientSecretBasic(clientSecret) : client.ClientSecretPost(clientSecret)
  const config = new client.Configuration(metadata, oidc.clientId, { client_secret: clientSecret }, auth)
  config.timeout = TIMEOUT
  config[client.customFetch] = FETCH
  for (const fn of execute) fn(config)
  return config
}

const cache = new Map<string, { key: string; at: number; config: Promise<client.Configuration> }>()

async function configFor(conn: SsoConnection): Promise<client.Configuration> {
  // Any change to the connection makes a new client
  const key = `${conn.updatedAt.getTime()}`
  const hit = cache.get(conn.id)
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.config
  const config = (async () => discover(oidcConfig(conn), conn.secret ? await openConnectionSecret(conn.secret) : ''))()
  cache.set(conn.id, { key, at: Date.now(), config })
  config.catch(() => cache.delete(conn.id))
  return config
}

// openid-client wraps the reason ("JWS signature verification failed") in a generic error; the
// whole chain is what an admin testing a connection needs to see
export function oidcErrorText(err: unknown): string {
  const parts: string[] = []
  for (let e: unknown = err; e instanceof Error && parts.length < 4; e = e.cause) {
    if (!parts.includes(e.message)) parts.push(e.message)
  }
  return parts.join(': ') || String(err)
}

export type OidcChecks = { state: string; nonce: string; verifier: string }

export function newChecks(): OidcChecks {
  return { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier() }
}

export async function authorizationUrl(conn: SsoConnection, checks: OidcChecks): Promise<string> {
  const config = await configFor(conn)
  return client
    .buildAuthorizationUrl(config, {
      redirect_uri: oidcRedirectUri(),
      scope: SCOPE,
      state: checks.state,
      nonce: checks.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(checks.verifier),
      code_challenge_method: 'S256',
    })
    .toString()
}

export type SsoIdentity = { subject: string; email: string | null; emailVerified: boolean; name: string | null }

// The person the provider signed in, once the code, the state, the nonce and the ID token check out.
// `search` is the query string of the callback; it is put on the configured redirect URI rather
// than on the request's own URL, whose host comes from the Host header.
export async function finishOidc(conn: SsoConnection, search: string, checks: OidcChecks): Promise<SsoIdentity> {
  const config = await configFor(conn)
  const current = new URL(oidcRedirectUri())
  current.search = search
  const tokens = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!claims) throw new Error('The provider sent no ID token')
  let email = typeof claims.email === 'string' ? claims.email : null
  let verified: unknown = claims.email_verified
  let name = typeof claims.name === 'string' ? claims.name : null
  // Some providers only put the address in the userinfo response
  if (!email && config.serverMetadata().userinfo_endpoint) {
    const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub)
    email = typeof info.email === 'string' ? info.email : null
    verified = info.email_verified
    name ??= typeof info.name === 'string' ? info.name : null
  }
  return {
    subject: claims.sub,
    email: email?.trim().toLowerCase() || null,
    // A few providers send the claim as a string
    emailVerified: verified === true || verified === 'true',
    name: name?.trim().slice(0, 80) || null,
  }
}
