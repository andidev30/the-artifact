import { createHash } from 'node:crypto'
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

export type PageUpload = {
  title?: string
  // Left out only by an update that keeps the page's current entry
  html?: Uint8Array
  files: { path: string; content: Uint8Array }[]
  id?: string
  visibility?: string
  folder?: string
  // An update: only these files change, and the paths in remove are left out; the rest are kept
  update?: { remove: string[] }
}

// POST /api/publish as multipart: the fields, index.html as the page, and one part per file, named
// by its path (docs/publishing.md, "Publishing without an agent")
export async function publishPage(auth: Auth, page: PageUpload): Promise<Published> {
  const build = () => {
    const form = new FormData()
    if (page.update) {
      form.append('mode', 'update')
      for (const path of page.update.remove) form.append('remove', path)
    }
    if (page.title !== undefined) form.append('title', page.title)
    if (page.id) form.append('artifact_id', page.id)
    if (page.visibility) form.append('visibility', page.visibility)
    if (page.folder !== undefined) form.append('folder', page.folder)
    if (page.html) form.append('index.html', new Blob([page.html as Uint8Array<ArrayBuffer>], { type: 'text/html' }), 'index.html')
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
type RpcMessage = { id?: unknown; result?: unknown; error?: { message?: string } }

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

// One JSON-RPC request to /mcp over streamable HTTP. The server at /mcp is stateless, so a request
// needs no initialize handshake or session, and this is all the client the CLI needs.
async function rpc(auth: Auth, method: string, params: Json): Promise<RpcMessage> {
  const res = await authorized(auth, '/mcp', () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  if (res.status === 401) throw new SignedOutError(signedOut(auth))
  const type = res.headers.get('content-type') ?? ''
  let message: RpcMessage | null
  if (type.includes('text/event-stream')) message = lastEvent(await res.text())
  else message = (await readJson(res)) as RpcMessage | null
  if (!res.ok && !message?.error) throw new CliError(errorMessage(message as Json | null, res))
  if (!message) throw new CliError(`${auth.server}/mcp gave an answer the CLI can't read.`)
  if (message.error) throw new CliError(message.error.message ?? `${method} failed.`)
  return message
}

export async function callTool(auth: Auth, name: string, args: Json): Promise<{ text: string; structured: unknown }> {
  const message = await rpc(auth, 'tools/call', { name, arguments: args })
  const result = (message.result ?? {}) as ToolResult
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  if (result.isError) throw new CliError(text || `${name} failed.`)
  return { text, structured: result.structuredContent }
}

// Whether the server takes direct uploads with answers the CLI can read: prepare_upload and
// publish_upload exist only when the server has S3_PUBLIC_ENDPOINT, and older servers answer them
// with text only
export async function canUpload(auth: Auth): Promise<boolean> {
  const message = await rpc(auth, 'tools/list', {})
  const tools = ((message.result as { tools?: { name?: string; outputSchema?: unknown }[] } | undefined)?.tools ?? []).filter((t) => t.outputSchema)
  return ['prepare_upload', 'publish_upload'].every((name) => tools.some((t) => t.name === name))
}

export class StorageUnreachable extends CliError {}

export type PageContent = { title: string; html: Uint8Array; files: { path: string; content: Uint8Array }[]; id?: string; visibility?: string; folder?: string }

type Prepared = { upload_id: string; uploads: { paths: string[]; size: number; url: string }[]; stored: string[] }

// Publishing by direct upload (docs/publishing.md): the server hands out a link for each file it
// doesn't have yet, and content already in a version of one of your own pages needs no upload. So a
// new version sends only the files that changed. Throws StorageUnreachable when the upload links
// can't be reached from here, so the caller can send the page the usual way instead.
export async function publishByUpload(auth: Auth, page: PageContent): Promise<Published & { uploaded: number }> {
  const contents = new Map<string, Uint8Array>([['index.html', page.html], ...page.files.map((f) => [f.path, f.content] as const)])
  const files = [...contents].map(([path, content]) => ({ path, size: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }))
  const prepared = (await callTool(auth, 'prepare_upload', { files })).structured as Prepared | undefined
  if (!prepared?.upload_id) throw new CliError(`${auth.server} gave an answer to prepare_upload the CLI can't read.`)
  for (const upload of prepared.uploads) {
    const content = contents.get(upload.paths[0])
    if (!content) throw new CliError(`${auth.server} asked for a file the CLI didn't send: ${upload.paths[0]}.`)
    let res: Response
    try {
      res = await fetch(upload.url, { method: 'PUT', body: content as Uint8Array<ArrayBuffer> })
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      throw new StorageUnreachable(
        `Could not reach the server's storage at ${new URL(upload.url).origin}: ${cause?.code ?? cause?.message ?? (err as Error).message}.`,
      )
    }
    if (!res.ok) throw new CliError(`Uploading ${upload.paths[0]} failed with ${res.status} ${res.statusText}.`.replace(' .', '.'))
  }
  const args: Json = { title: page.title, upload_id: prepared.upload_id, files }
  if (page.id) args.artifact_id = page.id
  if (page.visibility) args.visibility = page.visibility
  if (page.folder !== undefined) args.folder = page.folder
  const published = (await callTool(auth, 'publish_upload', args)).structured as Published | undefined
  if (!published?.url) throw new CliError(`${auth.server} gave an answer to publish_upload the CLI can't read.`)
  return { ...published, uploaded: prepared.uploads.length }
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
