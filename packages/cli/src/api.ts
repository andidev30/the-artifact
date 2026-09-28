import { readFileSync } from 'node:fs'
import { CliError, SignedOutError } from './errors.ts'

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const USER_AGENT = `the-artifact-cli/${VERSION} node/${process.versions.node}`

// Whatever gives the bearer token for a request: a token from the flag or the environment, or a
// saved sign-in that can refresh itself when the server refuses it
export type Auth = {
  server: string
  source: 'flag' | 'env' | 'saved'
  kind: 'token' | 'oauth'
  bearer(): Promise<string>
  // A fresh token after a 401, or false when there is nothing more to try
  renew(): Promise<boolean>
}

type Json = Record<string, unknown>

async function send(server: string, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('user-agent', USER_AGENT)
  try {
    return await fetch(`${server}${path}`, { ...init, headers })
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    throw new CliError(`Could not reach ${server}: ${cause?.code ?? cause?.message ?? (err as Error).message}.`)
  }
}

async function readJson(res: Response): Promise<Json | null> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Json) : null
  } catch {
    return null
  }
}

// The server's own message: { error } from the API, error_description from the OAuth endpoints
export function errorMessage(body: Json | null, res: Response): string {
  const description = typeof body?.error_description === 'string' ? body.error_description : null
  const error = typeof body?.error === 'string' ? body.error : null
  // OAuth errors put a code in error and the sentence in error_description
  if (description) return description
  if (error) return error
  return `${res.url} answered ${res.status} ${res.statusText}.`.replace(' .', '.')
}

function signedOut(auth: Auth): string {
  if (auth.source === 'flag') return 'The access token passed with --token was refused. It may have expired or been revoked.'
  if (auth.source === 'env') return 'The access token in THE_ARTIFACT_TOKEN was refused. It may have expired or been revoked.'
  if (auth.kind === 'token') return `The saved access token for ${auth.server} was refused. Run the-artifact login to sign in again.`
  return `Your sign-in to ${auth.server} has ended. Run the-artifact login to sign in again.`
}

// A request with the bearer token, retried once with a renewed one if the server refuses it. A body
// can only be sent once, so each attempt makes its own.
async function authorized(auth: Auth, path: string, request: () => RequestInit): Promise<Response> {
  const attempt = async () => {
    const init = request()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${await auth.bearer()}`)
    return send(auth.server, path, { ...init, headers })
  }
  let res = await attempt()
  if (res.status === 401 && (await auth.renew())) res = await attempt()
  return res
}

export type Published = { id: string; url: string; title: string; version: number; visibility: string; folder: string | null }

// POST /api/publish as multipart: the fields, index.html as the page, and one part per file, named
// by its path (docs/publishing.md, "Publishing without an agent")
export async function publishPage(
  auth: Auth,
  page: { title: string; html: Uint8Array; files: { path: string; content: Uint8Array }[]; id?: string; visibility?: string; folder?: string },
): Promise<Published> {
  const build = () => {
    const form = new FormData()
    form.append('title', page.title)
    if (page.id) form.append('artifact_id', page.id)
    if (page.visibility) form.append('visibility', page.visibility)
    if (page.folder !== undefined) form.append('folder', page.folder)
    form.append('index.html', new Blob([page.html as Uint8Array<ArrayBuffer>], { type: 'text/html' }), 'index.html')
    for (const f of page.files) form.append(f.path, new Blob([f.content as Uint8Array<ArrayBuffer>]), f.path.slice(f.path.lastIndexOf('/') + 1))
    return form
  }
  const res = await authorized(auth, '/api/publish', () => ({ method: 'POST', body: build() }))
  const body = await readJson(res)
  if (res.status === 401) throw new SignedOutError(signedOut(auth))
  if (!res.ok || !body) throw new CliError(errorMessage(body, res))
  return body as unknown as Published
}

export type WhoAmI = { email: string; name: string | null; workspace: { id: string | null; name: string }; client: string }

export async function whoami(auth: Auth): Promise<WhoAmI> {
  const res = await authorized(auth, '/api/whoami', () => ({ method: 'GET' }))
  const body = await readJson(res)
  if (res.status === 401) throw new SignedOutError(signedOut(auth))
  if (!res.ok || !body) throw new CliError(errorMessage(body, res))
  return body as unknown as WhoAmI
}

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
type RpcMessage = { id?: unknown; result?: ToolResult; error?: { message?: string } }

// The last JSON-RPC message of a text/event-stream answer. The server answers in plain JSON, but
// the streamable HTTP transport lets it stream, so both are read.
export function lastEvent(stream: string): RpcMessage | null {
  let last: RpcMessage | null = null
  for (const event of stream.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const message = JSON.parse(data) as RpcMessage
      if ('result' in message || 'error' in message) last = message
    } catch {
      // not JSON: a keep-alive or a comment
    }
  }
  return last
}

// One MCP tools/call over streamable HTTP. The server at /mcp is stateless, so a call needs no
// initialize handshake or session, and this is all the client the CLI needs.
export async function callTool(auth: Auth, name: string, args: Json): Promise<{ text: string; structured: unknown }> {
  const res = await authorized(auth, '/mcp', () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }))
  if (res.status === 401) throw new SignedOutError(signedOut(auth))
  const type = res.headers.get('content-type') ?? ''
  let message: RpcMessage | null
  if (type.includes('text/event-stream')) message = lastEvent(await res.text())
  else message = (await readJson(res)) as RpcMessage | null
  if (!res.ok && !message?.error) throw new CliError(errorMessage(message as Json | null, res))
  if (!message) throw new CliError(`${auth.server}/mcp gave an answer the CLI can't read.`)
  if (message.error) throw new CliError(message.error.message ?? `${name} failed.`)
  const result = message.result ?? {}
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  if (result.isError) throw new CliError(text || `${name} failed.`)
  return { text, structured: result.structuredContent }
}

// OAuth endpoints take form bodies and answer with error/error_description
export async function oauthPost(server: string, path: string, params: Record<string, string>): Promise<{ res: Response; body: Json | null }> {
  const res = await send(server, path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  })
  return { res, body: await readJson(res) }
}

export async function jsonPost(server: string, path: string, json: unknown): Promise<{ res: Response; body: Json | null }> {
  const res = await send(server, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(json),
  })
  return { res, body: await readJson(res) }
}
