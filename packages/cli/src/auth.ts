import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Auth, errorMessage, jsonPost, oauthPost } from './api.ts'
import { type Env, normalizeServer, readCredentials, type Saved, updateCredentials } from './config.ts'
import { CliError } from './errors.ts'

// Signing in is the browser sign-in MCP clients use (docs/connect-your-agent.md): the CLI registers
// itself with the server's OAuth server (RFC 7591), opens the consent page, and gets the code back on
// a loopback address (RFC 8252) with PKCE. The server needs nothing new for it, and the connection
// shows under Connected agents in settings, where it can be disconnected.
export const CLIENT_NAME = 'The Artifact CLI'
const SIGN_IN_TIMEOUT = 5 * 60 * 1000
// Refresh a little early, so a token doesn't expire between the check and the request
const EXPIRY_MARGIN = 60 * 1000

type Tokens = { access_token: string; refresh_token: string; expires_in: number }

function fromTokens(clientId: string, body: Tokens): Saved {
  return { kind: 'oauth', clientId, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 }
}

// Without --server, THE_ARTIFACT_URL or a saved sign-in, commands go to the hosted service
export const HOSTED_SERVER = 'https://the-artifact-pi.vercel.app'

export async function resolveServer(flag: string | undefined, env: Env): Promise<string> {
  const raw = flag ?? env.THE_ARTIFACT_URL
  if (raw) return normalizeServer(raw)
  const saved = (await readCredentials(env)).default
  return saved ?? HOSTED_SERVER
}

// Refresh tokens rotate, so two commands refreshing at once race: the loser's token is already used
// up. It then takes whatever the winner saved.
async function refreshed(server: string, env: Env, saved: Extract<Saved, { kind: 'oauth' }>): Promise<Saved | null> {
  const { res, body } = await oauthPost(server, '/oauth/token', { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId })
  if (res.ok && body?.access_token) {
    const next = fromTokens(saved.clientId, body as unknown as Tokens)
    await updateCredentials(env, (c) => {
      c.servers[server] = next
    })
    return next
  }
  const now = (await readCredentials(env)).servers[server]
  if (now?.kind === 'oauth' && now.refreshToken !== saved.refreshToken) return now
  return null
}

export async function resolveAuth(server: string, opts: { token?: string; env: Env }): Promise<Auth> {
  const { env } = opts
  const given = opts.token ?? env.THE_ARTIFACT_TOKEN
  if (given) {
    const token = given.trim()
    return { server, source: opts.token ? 'flag' : 'env', kind: 'token', bearer: async () => token, renew: async () => false }
  }
  let saved = (await readCredentials(env)).servers[server]
  if (!saved) {
    throw new CliError(`You're not signed in to ${server}. Run the-artifact login --server ${server}, or set THE_ARTIFACT_TOKEN to an access token.`)
  }
  if (saved.kind === 'token') {
    const token = saved.token
    return { server, source: 'saved', kind: 'token', bearer: async () => token, renew: async () => false }
  }
  let renewed = false
  const renew = async () => {
    if (renewed || saved.kind !== 'oauth') return false
    renewed = true
    const next = await refreshed(server, env, saved)
    if (!next) return false
    saved = next
    return true
  }
  return {
    server,
    source: 'saved',
    kind: 'oauth',
    bearer: async () => {
      if (saved.kind === 'oauth' && saved.expiresAt - EXPIRY_MARGIN < Date.now()) await renew()
      return saved.kind === 'oauth' ? saved.accessToken : saved.token
    },
    renew,
  }
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

// Never through a shell, so nothing in the URL is interpreted
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is printed too, so it can be opened by hand
  }
}

const DONE_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>The Artifact CLI</title><style>body{font:16px system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#1c2b4b}</style><p>${message}</p>`

// Waits on 127.0.0.1 for the browser to come back from the consent page with a code
async function loopback(state: string) {
  let settle: (r: { code: string } | { error: string }) => void = () => {}
  const result = new Promise<{ code: string } | { error: string }>((resolve) => {
    settle = resolve
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const ok = !error && code && url.searchParams.get('state') === state
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    res.end(DONE_PAGE(ok ? 'You are signed in. You can close this tab and go back to the terminal.' : 'Signing in did not finish. Go back to the terminal.'))
    if (ok) settle({ code })
    else if (error === 'access_denied') settle({ error: 'Signing in was cancelled.' })
    else
      settle({ error: url.searchParams.get('error_description') ?? (error ? `Signing in failed: ${error}.` : 'Signing in failed: the answer did not match.') })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return { redirectUri: `http://127.0.0.1:${port}/callback`, result, close: () => server.close() }
}

export async function browserLogin(server: string, opts: { open: boolean; log: (line: string) => void }): Promise<Saved> {
  const { verifier, challenge } = pkce()
  const state = randomBytes(16).toString('base64url')
  const wait = await loopback(state)
  let timer: NodeJS.Timeout | undefined
  try {
    const registered = await jsonPost(server, '/oauth/register', { client_name: CLIENT_NAME, redirect_uris: [wait.redirectUri] })
    const clientId = registered.body?.client_id
    if (!registered.res.ok || typeof clientId !== 'string') throw new CliError(errorMessage(registered.body, registered.res))

    const authorize = new URL(`${server}/oauth/authorize`)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: wait.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString()
    opts.log(opts.open ? `Opening your browser to sign in to ${server}.` : `Sign in to ${server} in your browser.`)
    opts.log(`If it doesn't open, go to:\n\n  ${authorize}\n`)
    if (opts.open) openBrowser(authorize.toString())

    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: 'Signing in timed out. Run the-artifact login to try again.' }), SIGN_IN_TIMEOUT)
    })
    const outcome = await Promise.race([wait.result, timeout])
    if ('error' in outcome) throw new CliError(outcome.error)

    const { res, body } = await oauthPost(server, '/oauth/token', {
      grant_type: 'authorization_code',
      code: outcome.code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: wait.redirectUri,
    })
    if (!res.ok || !body?.access_token) throw new CliError(errorMessage(body, res))
    return fromTokens(clientId, body as unknown as Tokens)
  } finally {
    clearTimeout(timer)
    wait.close()
  }
}

// Ends the connection on the server too (RFC 7009), so it leaves Connected agents. A server without
// the endpoint, or one that can't be reached, still gets signed out of locally.
export async function revoke(server: string, saved: Saved): Promise<void> {
  if (saved.kind !== 'oauth') return
  await oauthPost(server, '/oauth/revoke', { token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }).catch(() => {})
}
