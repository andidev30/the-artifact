import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A small OpenID Connect provider for tests: discovery, JWKS, and a token endpoint that hands out ID
// tokens signed with RS256. The browser's visit to the authorization endpoint is played by the test,
// which calls authorize() with what the app put in the authorization URL.

type Grant = { nonce: string; challenge: string; redirectUri: string; claims: Record<string, unknown> }

export type FakeProvider = {
  issuer: string
  clientId: string
  clientSecret: string
  // Claims for the next ID token, on top of iss, aud, sub, iat, exp and nonce
  claims: Record<string, unknown>
  // Sign ID tokens with a key the JWKS doesn't list
  signWithWrongKey: boolean
  // Put this nonce in ID tokens instead of the one the app sent
  nonceOverride: string | null
  // Issues a code for an authorization URL the app made, as the provider would after sign-in
  authorize(authorizationUrl: string): { code: string; state: string }
  tokenRequests: number
  close(): Promise<void>
}

function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function jwt(payload: Record<string, unknown>, key: KeyObject, kid: string) {
  const signed = `${b64url({ alg: 'RS256', typ: 'JWT', kid })}.${b64url(payload)}`
  return `${signed}.${sign('sha256', Buffer.from(signed), key).toString('base64url')}`
}

export async function startProvider(): Promise<FakeProvider> {
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'test-key'
  const grants = new Map<string, Grant>()
  let server: Server | null = null

  const provider: FakeProvider = {
    issuer: '',
    clientId: 'the-artifact',
    clientSecret: 'provider-secret',
    claims: {},
    signWithWrongKey: false,
    nonceOverride: null,
    tokenRequests: 0,
    authorize(authorizationUrl) {
      const url = new URL(authorizationUrl)
      const p = url.searchParams
      if (p.get('client_id') !== provider.clientId) throw new Error('wrong client_id')
      if (p.get('response_type') !== 'code') throw new Error('wrong response_type')
      if (p.get('code_challenge_method') !== 'S256') throw new Error('no PKCE')
      const code = randomBytes(16).toString('base64url')
      grants.set(code, {
        nonce: p.get('nonce') ?? '',
        challenge: p.get('code_challenge') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        claims: { ...provider.claims },
      })
      return { code, state: p.get('state') ?? '' }
    },
    close: () => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())),
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', provider.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/jwks') {
      return json(200, { keys: [{ ...good.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] })
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        provider.tokenRequests += 1
        const form = new URLSearchParams(body)
        const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString()
        const [id, secret] = basic.split(':').map(decodeURIComponent)
        if (id !== provider.clientId || secret !== provider.clientSecret) return json(401, { error: 'invalid_client' })
        const grant = grants.get(form.get('code') ?? '')
        grants.delete(form.get('code') ?? '')
        if (!grant || grant.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' })
        const verifier = form.get('code_verifier') ?? ''
        if (createHash('sha256').update(verifier).digest('base64url') !== grant.challenge)
          return json(400, { error: 'invalid_grant', error_description: 'PKCE' })
        const now = Math.floor(Date.now() / 1000)
        const idToken = jwt(
          {
            iss: provider.issuer,
            aud: provider.clientId,
            sub: 'user-1',
            iat: now,
            exp: now + 300,
            nonce: provider.nonceOverride ?? grant.nonce,
            ...grant.claims,
          },
          provider.signWithWrongKey ? wrong.privateKey : good.privateKey,
          kid,
        )
        json(200, { access_token: randomBytes(16).toString('base64url'), token_type: 'Bearer', expires_in: 300, id_token: idToken })
      })
      return
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  provider.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return provider
}
