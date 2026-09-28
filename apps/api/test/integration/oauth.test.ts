import { describe, expect, it } from 'vitest'
import { db, schema } from '../../src/db/index.js'
import {
  approve,
  call,
  connectAgent,
  createOrg,
  createUser,
  mcpRequest,
  pkcePair,
  REDIRECT_URI,
  registerClient,
  startAuthorize,
  type Tokens,
} from './helpers.js'

function token(form: Record<string, string>) {
  return call('/oauth/token', { form })
}

describe('discovery', () => {
  it('serves protected resource metadata for /mcp', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await call(path)
      expect(await res.json()).toMatchObject({
        resource: 'http://localhost:5177/mcp',
        authorization_servers: ['http://localhost:5177'],
      })
    }
  })

  it('serves authorization server metadata', async () => {
    const meta = await (await call('/.well-known/oauth-authorization-server')).json()
    expect(meta).toMatchObject({
      issuer: 'http://localhost:5177',
      authorization_endpoint: 'http://localhost:5177/oauth/authorize',
      token_endpoint: 'http://localhost:5177/oauth/token',
      registration_endpoint: 'http://localhost:5177/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('/mcp without a token points clients at the metadata', async () => {
    const res = await call('/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'initialize' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost:5177/.well-known/oauth-protected-resource/mcp"')
    expect((await call('/mcp', { bearer: 'not-a-token', json: {} })).status).toBe(401)
  })
})

describe('client registration', () => {
  it('registers a public client', async () => {
    const client = await registerClient('  Cursor  ', ['cursor://anysphere/cb', 'http://localhost:9999/cb'])
    expect(client).toMatchObject({ client_name: 'Cursor', redirect_uris: ['cursor://anysphere/cb', 'http://localhost:9999/cb'] })
    expect(client.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('defaults the name', async () => {
    const res = await call('/oauth/register', { json: { redirect_uris: [REDIRECT_URI] } })
    expect((await res.json()).client_name).toBe('MCP client')
  })

  it.each([
    [{}],
    [{ redirect_uris: [] }],
    [{ redirect_uris: ['http://evil.example.com/cb'] }],
    [{ redirect_uris: ['https://ok.example.com/cb', 'javascript:alert(1)'] }],
    [{ redirect_uris: 'https://ok.example.com/cb' }],
  ])('rejects %o', async (body) => {
    const res = await call('/oauth/register', { json: body })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_redirect_uri')
  })
})

describe('authorization', () => {
  it('shows errors on the web app when the client or redirect is not trusted', async () => {
    const unknown = await call(`/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`)
    expect(unknown.headers.get('location')).toBe('http://localhost:5177/authorize?error=unknown_client')

    const client = await registerClient()
    const bad = await call(`/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`)
    expect(bad.headers.get('location')).toBe('http://localhost:5177/authorize?error=bad_redirect')
  })

  it('sends protocol errors back to the client with its state', async () => {
    const client = await registerClient()
    const base = { client_id: client.client_id, redirect_uri: REDIRECT_URI, state: 'xyz' }

    const noCode = await call(`/oauth/authorize?${new URLSearchParams({ ...base, response_type: 'token' })}`)
    const noCodeUrl = new URL(noCode.headers.get('location')!)
    expect(noCodeUrl.origin + noCodeUrl.pathname).toBe('http://127.0.0.1:43123/callback')
    expect(noCodeUrl.searchParams.get('error')).toBe('unsupported_response_type')
    expect(noCodeUrl.searchParams.get('state')).toBe('xyz')

    const plain = await call(
      `/oauth/authorize?${new URLSearchParams({ ...base, response_type: 'code', code_challenge: 'abc', code_challenge_method: 'plain' })}`,
    )
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')

    const none = await call(`/oauth/authorize?${new URLSearchParams({ ...base, response_type: 'code' })}`)
    expect(new URL(none.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
  })

  it('accepts a loopback redirect on another port', async () => {
    const client = await registerClient()
    const { challenge } = pkcePair()
    const id = await startAuthorize(client.client_id, challenge, { redirectUri: 'http://127.0.0.1:50000/callback' })
    expect(id).toBeTruthy()
  })

  it('the consent request needs a session and describes the client', async () => {
    const user = await createUser()
    const org = await createOrg(user, 'Acme', 'acme')
    const client = await registerClient('Claude Code')
    const id = await startAuthorize(client.client_id, pkcePair().challenge)

    expect((await call(`/api/oauth/requests/${id}`)).status).toBe(401)
    const res = await call(`/api/oauth/requests/${id}`, { cookie: user.cookie })
    expect(await res.json()).toEqual({
      clientName: 'Claude Code',
      redirectHost: '127.0.0.1:43123',
      workspaces: [
        { id: org.id, name: 'Acme', blocked: false },
        { id: null, name: 'Personal', blocked: false },
      ],
    })
    expect((await call('/api/oauth/requests/unknown', { cookie: user.cookie })).status).toBe(404)
  })

  it('refuses an organization the person is not in', async () => {
    const user = await createUser()
    const other = await createUser()
    const org = await createOrg(other, 'Other', 'other')
    const client = await registerClient()
    const id = await startAuthorize(client.client_id, pkcePair().challenge)
    const res = await call(`/api/oauth/requests/${id}/approve`, { cookie: user.cookie, json: { organizationId: org.id } })
    expect(res.status).toBe(403)
  })

  it('deny sends access_denied back and closes the request', async () => {
    const user = await createUser()
    const client = await registerClient()
    const id = await startAuthorize(client.client_id, pkcePair().challenge, { state: 's1' })
    const res = await call(`/api/oauth/requests/${id}/deny`, { method: 'POST', cookie: user.cookie })
    const redirect = new URL((await res.json()).redirect)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe('s1')
    expect((await call(`/api/oauth/requests/${id}`, { cookie: user.cookie })).status).toBe(404)
  })
})

describe('full MCP OAuth flow', () => {
  it('register, authorize, consent, token, refresh rotation', async () => {
    const user = await createUser({ email: 'dev@example.com' })
    const org = await createOrg(user, 'Acme', 'acme')

    // Register and authorize
    const client = await registerClient('claude-code')
    const { verifier, challenge } = pkcePair()
    const requestId = await startAuthorize(client.client_id, challenge, { state: 'state-123' })

    // Consent in the web app
    const { code, state, redirect } = await approve(user, requestId, org.id)
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI)
    expect(state).toBe('state-123')
    // A request can be approved only once
    expect((await call(`/api/oauth/requests/${requestId}/approve`, { cookie: user.cookie, json: {} })).status).toBe(404)

    // Exchange the code
    const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT_URI })
    expect(res.status).toBe(200)
    const tokens = (await res.json()) as Tokens
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'artifacts' })
    expect(tokens.access_token).not.toBe(tokens.refresh_token)

    // Codes work once
    const reuse = await token({ grant_type: 'authorization_code', code, code_verifier: verifier })
    expect(reuse.status).toBe(400)
    expect((await reuse.json()).error).toBe('invalid_grant')

    // The access token works on /mcp and acts for the chosen organization
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(200)
    const me = await (await call('/api/me', { cookie: user.cookie })).json()
    expect(me.agentConnected).toBe(true)
    const [stored] = await db.select().from(schema.oauthTokens).limit(1)
    expect(stored.organizationId).toBe(org.id)

    // Refresh rotates
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as Tokens
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(next.access_token).not.toBe(tokens.access_token)
    expect((await mcpRequest(next.access_token, 'tools/list')).status).toBe(200)

    // The old refresh token no longer works
    const old = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    expect(old.status).toBe(400)
    expect((await old.json()).error).toBe('invalid_grant')

    // The new one still does
    expect((await token({ grant_type: 'refresh_token', refresh_token: next.refresh_token })).status).toBe(200)
  })

  it('rejects the wrong PKCE verifier', async () => {
    const user = await createUser()
    const client = await registerClient()
    const { challenge } = pkcePair()
    const { code } = await approve(user, await startAuthorize(client.client_id, challenge))
    const res = await token({ grant_type: 'authorization_code', code, code_verifier: pkcePair().verifier })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringMatching(/PKCE/) })
    expect(await db.select().from(schema.oauthTokens)).toHaveLength(0)
  })

  it('rejects a code sent by another client or with another redirect_uri', async () => {
    const user = await createUser()
    const client = await registerClient()
    const other = await registerClient('other')

    const a = pkcePair()
    const { code: codeA } = await approve(user, await startAuthorize(client.client_id, a.challenge))
    const wrongClient = await token({ grant_type: 'authorization_code', code: codeA, code_verifier: a.verifier, client_id: other.client_id })
    expect((await wrongClient.json()).error).toBe('invalid_grant')

    const b = pkcePair()
    const { code: codeB } = await approve(user, await startAuthorize(client.client_id, b.challenge))
    const wrongRedirect = await token({
      grant_type: 'authorization_code',
      code: codeB,
      code_verifier: b.verifier,
      redirect_uri: 'http://127.0.0.1:43123/other',
    })
    expect((await wrongRedirect.json()).error).toBe('invalid_grant')
  })

  it('rejects an expired code', async () => {
    const user = await createUser()
    const client = await registerClient()
    const { verifier, challenge } = pkcePair()
    const { code } = await approve(user, await startAuthorize(client.client_id, challenge))
    await db.update(schema.oauthGrants).set({ expiresAt: new Date(Date.now() - 1000) })
    const res = await token({ grant_type: 'authorization_code', code, code_verifier: verifier })
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('accepts a JSON token request', async () => {
    const user = await createUser()
    const client = await registerClient()
    const { verifier, challenge } = pkcePair()
    const { code } = await approve(user, await startAuthorize(client.client_id, challenge))
    const res = await call('/oauth/token', { json: { grant_type: 'authorization_code', code, code_verifier: verifier } })
    expect(res.status).toBe(200)
  })

  it('rejects malformed token requests', async () => {
    expect((await (await token({ grant_type: 'password' })).json()).error).toBe('unsupported_grant_type')
    expect((await (await token({ grant_type: 'authorization_code', code: 'x' })).json()).error).toBe('invalid_request')
    expect((await (await token({ grant_type: 'refresh_token' })).json()).error).toBe('invalid_request')
    expect((await (await token({ grant_type: 'refresh_token', refresh_token: 'nope' })).json()).error).toBe('invalid_grant')
  })

  it('an access token cannot be used as a refresh token, nor the other way round', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    expect((await (await token({ grant_type: 'refresh_token', refresh_token: tokens.access_token })).json()).error).toBe('invalid_grant')
    expect((await mcpRequest(tokens.refresh_token, 'tools/list')).status).toBe(401)
  })

  it('refresh tokens are bound to their client', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    const other = await registerClient('other')
    const res = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.client_id })
    expect((await res.json()).error).toBe('invalid_grant')
    // The attempt from the wrong client didn't use the token up
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(200)
  })

  it('expired access tokens are rejected', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    await db.update(schema.oauthTokens).set({ expiresAt: new Date(Date.now() - 1000) })
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(401)
  })
})

describe('token revocation', () => {
  const revoke = (form: Record<string, string>) => call('/oauth/revoke', { method: 'POST', form })

  it('advertises the endpoint', async () => {
    const meta = await (await call('/.well-known/oauth-authorization-server')).json()
    expect(meta.revocation_endpoint).toBe('http://localhost:5177/oauth/revoke')
  })

  it('revoking a refresh token ends the whole connection', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    const other = await connectAgent(user, null, 'cursor')
    expect((await revoke({ token: tokens.refresh_token })).status).toBe(200)
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(401)
    // Other agents stay connected
    expect((await mcpRequest(other.access_token, 'tools/list')).status).toBe(200)
  })

  it('answers the same for unknown tokens, and ignores a token from another client', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    const other = await registerClient('other')
    expect((await revoke({ token: 'nope' })).status).toBe(200)
    expect((await revoke({ token: tokens.access_token, client_id: other.client_id })).status).toBe(200)
    expect((await mcpRequest(tokens.access_token, 'tools/list')).status).toBe(200)
    expect((await revoke({})).status).toBe(400)
  })
})
