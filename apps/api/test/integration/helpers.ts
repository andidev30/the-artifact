import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { app } from '../../src/app.js'
import { publish } from '../../src/artifacts.js'
import { hashToken, randomToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import type { Role, Visibility } from '../../src/db/schema.js'

type RequestOptions = {
  method?: string
  cookie?: string
  bearer?: string
  json?: unknown
  form?: Record<string, string>
  headers?: Record<string, string>
}

// Calls the Hono app in-process, no server needed
export function call(path: string, opts: RequestOptions = {}) {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  }
  return app.request(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body })
}

// "session=<token>" from a response that started a session, or null
export function sessionCookie(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('session='))
  const value = header?.split(';')[0]
  return value && value !== 'session=' ? value : null
}

export type TestUser = { id: string; email: string; name: string | null; cookie: string }

let counter = 0

// A signed-in person, created directly in the database (sign-in itself is covered in auth.test.ts)
export async function createUser(opts: { email?: string; name?: string; onboarded?: boolean } = {}): Promise<TestUser> {
  counter += 1
  const email = (opts.email ?? `user${counter}@example.com`).toLowerCase()
  const [user] = await db
    .insert(schema.users)
    .values({ email, name: opts.name ?? null, onboardedAt: opts.onboarded === false ? null : new Date() })
    .returning()
  const token = randomToken()
  await db.insert(schema.sessions).values({ id: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) })
  return { id: user.id, email, name: user.name, cookie: `session=${token}` }
}

export async function createOrg(owner: TestUser, name = 'Acme Inc', slug = 'acme') {
  const res = await call('/api/organizations', { cookie: owner.cookie, json: { name, slug } })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; name: string; slug: string; role: Role }
}

export async function addMember(organizationId: string, user: TestUser, role: Role) {
  await db.insert(schema.memberships).values({ organizationId, userId: user.id, role })
}

export async function createPage(owner: TestUser, opts: { organizationId?: string | null; visibility?: Visibility; title?: string; html?: string } = {}) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId: opts.organizationId ?? null,
    clientName: 'test-client',
    title: opts.title ?? 'Test page',
    html: opts.html ?? '<!doctype html><h1>Hello</h1>',
    visibility: opts.visibility,
  })
}

export function pkcePair() {
  const verifier = randomToken()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export const REDIRECT_URI = 'http://127.0.0.1:43123/callback'

export async function registerClient(name = 'claude-code', redirectUris = [REDIRECT_URI]) {
  const res = await call('/oauth/register', { json: { client_name: name, redirect_uris: redirectUris } })
  expect(res.status).toBe(201)
  return (await res.json()) as { client_id: string; client_name: string; redirect_uris: string[] }
}

// /oauth/authorize, returning the consent request id the web app would show
export async function startAuthorize(clientId: string, challenge: string, opts: { redirectUri?: string; state?: string } = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: opts.redirectUri ?? REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(opts.state ? { state: opts.state } : {}),
  })
  const res = await call(`/oauth/authorize?${q}`)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe('http://localhost:5177/authorize')
  return location.searchParams.get('request')!
}

export async function approve(user: TestUser, requestId: string, organizationId: string | null = null) {
  const res = await call(`/api/oauth/requests/${requestId}/approve`, { cookie: user.cookie, json: { organizationId } })
  expect(res.status).toBe(200)
  const redirect = new URL(((await res.json()) as { redirect: string }).redirect)
  return { code: redirect.searchParams.get('code')!, state: redirect.searchParams.get('state'), redirect }
}

export type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }

// The whole browser sign-in an MCP client goes through, ending with tokens
export async function connectAgent(user: TestUser, organizationId: string | null = null, clientName = 'claude-code'): Promise<Tokens> {
  const client = await registerClient(clientName)
  const { verifier, challenge } = pkcePair()
  const requestId = await startAuthorize(client.client_id, challenge)
  const { code } = await approve(user, requestId, organizationId)
  const res = await call('/oauth/token', {
    form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT_URI },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Tokens
}

let rpcId = 0

export async function mcpRequest(token: string, method: string, params: Record<string, unknown> = {}) {
  rpcId += 1
  return call('/mcp', {
    bearer: token,
    headers: { accept: 'application/json, text/event-stream' },
    json: { jsonrpc: '2.0', id: rpcId, method, params },
  })
}

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcpRequest(token, 'tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result?: ToolResult; error?: { message: string } }
  if (!body.result) throw new Error(`tools/call ${name} failed: ${body.error?.message}`)
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: Boolean(body.result.isError) }
}

export function slugFrom(text: string): string {
  const slug = text.match(/artifact_id: ([a-z0-9]+)/)?.[1]
  if (!slug) throw new Error(`No artifact_id in: ${text}`)
  return slug
}
