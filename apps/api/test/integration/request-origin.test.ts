import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { hashPassword } from '../../src/auth/password.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { call, connectAgent, createUser, REDIRECT_URI, sessionCookie, type TestUser } from './helpers.js'

const PASSWORD = 'correct horse battery'
const original = { selfHosted: env.selfHosted }

afterEach(() => {
  env.selfHosted = original.selfHosted
})

async function withPassword(user: TestUser) {
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(schema.users.id, user.id))
}

// A request as a browser sends it, with only the headers given
function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  return app.request(path, { method: init.method ?? 'POST', headers: init.headers, body: init.body })
}

const loginBody = (email: string) => JSON.stringify({ email, password: PASSWORD })

describe('state-changing requests under /api', () => {
  it('are refused when another site sends them', async () => {
    const user = await createUser()
    await withPassword(user)
    for (const headers of <Record<string, string>[]>[
      { origin: 'https://elsewhere.example' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://elsewhere.example' },
      // A sibling host on the same site, such as a content origin
      { 'sec-fetch-site': 'same-site', origin: 'http://content.localhost:5177' },
      // Sec-Fetch-Site decides when a browser sends it
      { 'sec-fetch-site': 'cross-site', origin: env.appUrl },
      // Neither header: no browser sends such a write
      {},
    ]) {
      const res = await send('/api/auth/password/login', { headers: { ...headers, 'content-type': 'application/json' }, body: loginBody(user.email) })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'This request did not come from this app. Reload the page and try again.' })
      expect(sessionCookie(res)).toBeNull()
    }
  })

  it('refuse a plain-text form that carries JSON', async () => {
    const user = await createUser()
    await withPassword(user)
    const body = `{"email":"${user.email}","password":"${PASSWORD}","x":"="}`
    const crossSite = await send('/api/auth/password/login', { headers: { 'content-type': 'text/plain', origin: 'https://elsewhere.example' }, body })
    expect(crossSite.status).toBe(403)
    expect(sessionCookie(crossSite)).toBeNull()
    // Even from this app, a body must be JSON
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await send('/api/auth/password/login', { headers: { 'content-type': type, origin: env.appUrl }, body })
      expect(res.status).toBe(415)
      expect(sessionCookie(res)).toBeNull()
    }
  })

  it('are accepted from the app itself', async () => {
    const user = await createUser()
    await withPassword(user)
    for (const headers of <Record<string, string>[]>[
      { 'sec-fetch-site': 'same-origin', origin: env.appUrl },
      // Something the person did themselves, such as reloading
      { 'sec-fetch-site': 'none' },
      // Browsers without Sec-Fetch-Site
      { origin: env.appUrl },
    ]) {
      const res = await send('/api/auth/password/login', {
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
        body: loginBody(user.email),
      })
      expect(res.status).toBe(200)
      expect(sessionCookie(res)).toBeTruthy()
    }
  })

  it('protect routes that use the session cookie', async () => {
    const user = await createUser()
    const rename = (headers: Record<string, string>) =>
      send('/api/me', {
        method: 'PATCH',
        headers: { cookie: user.cookie, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ name: 'Changed' }),
      })
    expect((await rename({ origin: 'https://elsewhere.example' })).status).toBe(403)
    expect((await send('/api/auth/logout', { headers: { cookie: user.cookie, 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect((await send('/api/me', { method: 'DELETE', headers: { cookie: user.cookie, origin: 'null' } })).status).toBe(403)
    expect((await call('/api/me', { cookie: user.cookie })).status).toBe(200)
    expect((await rename({ origin: env.appUrl })).status).toBe(200)
    // Requests without a body need no Content-Type
    expect((await send('/api/auth/logout', { headers: { cookie: user.cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204)
  })

  it('leave reads alone', async () => {
    const user = await createUser()
    const res = await send('/api/me', { method: 'GET', headers: { cookie: user.cookie, 'sec-fetch-site': 'cross-site', origin: 'https://elsewhere.example' } })
    expect(res.status).toBe(200)
  })

  it('leave requests with a bearer token alone', async () => {
    const res = await send('/api/auth/logout', { headers: { authorization: 'Bearer anything' } })
    expect(res.status).toBe(204)
  })
})

describe('requests other sites and clients send by design', () => {
  it('the SAML response an IdP posts to the ACS', async () => {
    env.selfHosted = true
    const res = await send('/api/auth/sso/saml/acs', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://idp.example', 'sec-fetch-site': 'cross-site' },
      body: new URLSearchParams({ SAMLResponse: 'not a real response', RelayState: '/app' }).toString(),
    })
    // Refused by the SAML checks, not by the origin check
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^http:\/\/localhost:5177\/login\?error=sso_/)
  })

  it('OAuth client registration, tokens and revocation, from a client with no Origin', async () => {
    const registered = await send('/oauth/register', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'client', redirect_uris: [REDIRECT_URI] }),
    })
    expect(registered.status).toBe(201)
    const token = await send('/oauth/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://elsewhere.example' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'nope' }).toString(),
    })
    expect(token.status).toBe(400)
    const revoked = await send('/oauth/revoke', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nope' })
    expect(revoked.status).toBe(200)
  })

  it('agents over MCP and scripts publishing with a token', async () => {
    const user = await createUser()
    const { access_token: token } = await connectAgent(user)
    const listed = await send('/mcp', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(listed.status).toBe(200)
    const published = await send('/api/publish', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Report', html: '<h1>Report</h1>' }),
    })
    expect(published.status).toBe(201)
  })

  it('sign-in callbacks, which are GET requests', async () => {
    const google = await send('/api/auth/google/callback?code=x&state=y', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(google.status).toBe(302)
    const oidc = await send('/api/auth/sso/oidc/callback?code=x&state=y', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(oidc.status).not.toBe(403)
  })
})
