import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { env } from '../../src/env.js'
import { MAX_FILE_BYTES, MAX_HTML_BYTES } from '../../src/files.js'
import { call, callTool, connectAgent, createUser } from './helpers.js'

const MB = 1024 * 1024

// A body without Content-Length, as a client streaming it would send
function streamed(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('request bodies', () => {
  it('are refused past 1 MB on routes anyone can reach', async () => {
    const big = JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(MB) })
    const headers = { origin: env.appUrl, 'content-type': 'application/json' }
    for (const path of ['/api/auth/password/login', '/api/auth/email', '/oauth/register', '/api/auth/sso/saml/acs', '/scim/v2/Users']) {
      expect((await app.request(path, { method: 'POST', headers, body: '{}' })).status, path).not.toBe(413)
      const res = await app.request(path, { method: 'POST', headers, body: big })
      expect(res.status, path).toBe(413)
      expect(await res.json()).toEqual({ error: 'This request is too large. It can be up to 1 MB.' })
    }
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x'.repeat(MB) }).toString(),
    })
    expect(token.status).toBe(413)
  })

  it('are counted as they arrive when there is no Content-Length', async () => {
    const res = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { origin: env.appUrl, 'content-type': 'application/json' },
      body: streamed(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(MB) })),
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    const small = await app.request('/api/auth/password/login', {
      method: 'POST',
      headers: { origin: env.appUrl, 'content-type': 'application/json' },
      body: streamed(JSON.stringify({ email: 'nobody@example.com', password: 'wrong' })),
      duplex: 'half',
    } as RequestInit)
    expect(small.status).toBe(401)
  })

  it('still take a page as large as the page limits allow over /api/publish', async () => {
    const user = await createUser()
    const { access_token } = await connectAgent(user)
    const html = `<!doctype html><title>Big</title>${'x'.repeat(MAX_HTML_BYTES - 40)}`
    const files = [1, 2].map((n) => ({ path: `img/${n}.png`, content: randomBytes(MAX_FILE_BYTES - MB).toString('base64'), encoding: 'base64' }))
    const res = await call('/api/publish', { bearer: access_token, json: { title: 'Big', html, files } })
    expect(res.status).toBe(201)
  })

  it('still take a publish over MCP past the default limit', async () => {
    const user = await createUser()
    const { access_token } = await connectAgent(user)
    const html = `<!doctype html><title>Big</title>${'x'.repeat(MAX_HTML_BYTES - 40)}`
    const result = await callTool(access_token, 'publish_artifact', { title: 'Big', html, files: [{ path: 'data.txt', content: 'y'.repeat(1.5 * MB) }] })
    expect(result.isError).toBe(false)
  })

  it('may carry pasted SAML metadata to the SSO settings', async () => {
    const admin = await createUser({ admin: true })
    const res = await call('/api/admin/sso', { cookie: admin.cookie, json: { protocol: 'saml', name: 'IdP', metadataXml: 'x'.repeat(1.5 * MB) } })
    expect(res.status).not.toBe(413)
  })
})
