import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../src/env.js'
import { log } from '../../src/log.js'
import { call, callTool, connectAgent, createPage, createUser, pkcePair, REDIRECT_URI, registerClient } from './helpers.js'

// Input Postgres can't take (NUL in text, numbers past an integer column) is answered like any other
// missing page or wrong field, never with a server error
const NUL = encodeURIComponent('a\u0000b')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('malformed page ids', () => {
  it('are missing pages on every route that takes one', async () => {
    const errors = vi.spyOn(log, 'error')
    const owner = await createUser()
    for (const path of [
      `/api/artifacts/${NUL}`,
      `/api/artifacts/${NUL}/content`,
      `/api/artifacts/${NUL}/download`,
      `/api/artifacts/${NUL}/thumbnails/1`,
      `/api/artifacts/${NUL}/v/1/`,
      `/api/artifacts/${NUL}/versions`,
      `/api/artifacts/${NUL}/versions/1`,
      `/api/artifacts/${NUL}/views`,
      `/api/artifacts/${NUL}/sharing`,
      `/api/artifacts/${NUL}/comments`,
      `/api/artifacts/${encodeURIComponent('\u0001')}`,
      `/e/${NUL}`,
      `/api/oembed?url=${encodeURIComponent(`${env.appUrl}/a/a\u0000b`)}`,
    ]) {
      expect((await call(path, { cookie: owner.cookie })).status, path).toBe(404)
      // Signed out, routes for signed-in people ask for a sign-in first
      expect([401, 404], path).toContain((await call(path)).status)
    }
    for (const [method, path] of [
      ['POST', `/api/artifacts/${NUL}/unlock`],
      ['PATCH', `/api/artifacts/${NUL}`],
      ['DELETE', `/api/artifacts/${NUL}`],
      ['POST', `/api/artifacts/${NUL}/versions/1/restore`],
    ]) {
      const res = await call(path, { method, cookie: owner.cookie, json: { title: 'x', password: 'x' } })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(errors).not.toHaveBeenCalled()
  })

  it('are missing pages to agents', async () => {
    const owner = await createUser()
    const { access_token } = await connectAgent(owner)
    for (const tool of ['get_artifact', 'list_versions', 'download_artifact', 'delete_artifact']) {
      const result = await callTool(access_token, tool, { artifact_id: 'a\u0000b' })
      expect(result.isError, tool).toBe(true)
      expect(result.text).toMatch(/^No page you (can|own)/)
    }
  })
})

describe('version numbers', () => {
  const BAD = ['0', '-1', '+1', '01', '1.0', '1e0', '0x1', '2147483648', '99999999999', '1'.repeat(40)]

  it('only plain whole numbers in range name a version', async () => {
    const errors = vi.spyOn(log, 'error')
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const base = `/api/artifacts/${page.slug}`

    expect((await call(`${base}/versions/1`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`${base}/v/1/`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`${base}/download?version=1`, { cookie: owner.cookie })).status).toBe(200)
    expect((await call(`${base}/compare?from=1&to=1`, { cookie: owner.cookie })).status).toBe(200)

    for (const n of BAD) {
      const v = encodeURIComponent(n)
      for (const path of [
        `${base}/versions/${v}`,
        `${base}/thumbnails/${v}`,
        `${base}/v/${v}/`,
        `${base}/v/${v}/index.html`,
        `${base}/download?version=${v}`,
        `${base}/compare?from=${v}&to=1`,
        `${base}/compare?from=1&to=${v}`,
      ]) {
        expect((await call(path, { cookie: owner.cookie })).status, path).toBe(404)
      }
      expect((await call(`${base}/versions/${v}/restore`, { cookie: owner.cookie, method: 'POST', json: {} })).status, n).toBe(404)
    }
    expect(errors).not.toHaveBeenCalled()
  })

  it('agents get an error for a version out of range', async () => {
    const owner = await createUser()
    const page = await createPage(owner)
    const { access_token } = await connectAgent(owner)
    for (const tool of ['restore_version', 'download_artifact']) {
      const result = await callTool(access_token, tool, { artifact_id: page.slug, version: 2147483648 })
      expect(result.isError, tool).toBe(true)
    }
    expect((await callTool(access_token, 'diff_versions', { artifact_id: page.slug, from: 1, to: 2147483648 })).isError).toBe(true)
    expect((await callTool(access_token, 'diff_versions', { artifact_id: page.slug, from: 0, to: 1 })).isError).toBe(true)
  })
})

describe('sign-in and agent authorization', () => {
  it('refuses an email address with control characters as a wrong field', async () => {
    for (const email of ['a\u0000b@example.com', 'a@example.com\u0000']) {
      const res = await call('/api/auth/password/login', { json: { email, password: 'correct horse battery' } })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'email' })
      expect((await call('/api/auth/email', { json: { email } })).status).toBe(400)
    }
  })

  it('treats a malformed client id as an unknown client', async () => {
    const errors = vi.spyOn(log, 'error')
    const { challenge } = pkcePair()
    for (const clientId of ['a\u0000b', 'x'.repeat(200), 'a b']) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      const res = await call(`/oauth/authorize?${q}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('http://localhost:5177/authorize?error=unknown_client')
    }
    expect(errors).not.toHaveBeenCalled()
  })

  it('sends a malformed state or challenge back to the client as invalid_request', async () => {
    const client = await registerClient()
    const { challenge } = pkcePair()
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT_URI, code_challenge_method: 'S256' }
    for (const q of [
      { ...base, code_challenge: challenge, state: 'a\u0000b' },
      { ...base, code_challenge: challenge, state: 'café' },
      { ...base, code_challenge: 'a\u0000b', state: 'ok' },
      { ...base, code_challenge: 'short', state: 'ok' },
    ]) {
      const res = await call(`/oauth/authorize?${new URLSearchParams(q)}`)
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin + location.pathname).toBe('http://127.0.0.1:43123/callback')
      expect(location.searchParams.get('error')).toBe('invalid_request')
      expect(location.searchParams.get('state')).toBe(q.state === 'ok' ? 'ok' : null)
    }
  })
})
