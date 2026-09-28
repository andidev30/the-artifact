import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { CliError, UsageError } from './errors.ts'

export type Env = Record<string, string | undefined>

export type Saved =
  // From `login`: an OAuth connection, which shows under Connected agents in settings
  | { kind: 'oauth'; clientId: string; accessToken: string; refreshToken: string; expiresAt: number }
  // From `login --with-token`: an access token from settings
  | { kind: 'token'; token: string }

export type Credentials = { default?: string; servers: Record<string, Saved> }

// Where credentials live: %APPDATA%\the-artifact on Windows, $XDG_CONFIG_HOME/the-artifact or
// ~/.config/the-artifact elsewhere. THE_ARTIFACT_CONFIG_DIR overrides it (tests, several accounts).
export function configDir(env: Env, platform = process.platform): string {
  if (env.THE_ARTIFACT_CONFIG_DIR) return env.THE_ARTIFACT_CONFIG_DIR
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'the-artifact')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'the-artifact')
}

function credentialsPath(env: Env) {
  return join(configDir(env), 'credentials.json')
}

export async function readCredentials(env: Env): Promise<Credentials> {
  let raw: string
  try {
    raw = await readFile(credentialsPath(env), 'utf8')
  } catch {
    return { servers: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Credentials
    return { default: parsed.default, servers: parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {} }
  } catch {
    throw new CliError(`${credentialsPath(env)} can't be read. Delete it and sign in again.`)
  }
}

// Written to a temporary file first and renamed, so a crash never leaves half a file, and readable by
// the owner only: it holds tokens that publish as you
export async function writeCredentials(env: Env, creds: Credentials) {
  const path = credentialsPath(env)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  // mode is ignored when the file already exists
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

export async function updateCredentials(env: Env, change: (creds: Credentials) => void) {
  const creds = await readCredentials(env)
  change(creds)
  await writeCredentials(env, creds)
}

// https://example.com, from https://example.com/, https://example.com/mcp (the address agents are
// given) or a bare host
export function normalizeServer(raw: string): string {
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`${raw} isn't a server address. Pass it like https://artifact.example.com.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`${raw} isn't an http or https address.`)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '')
  return `${url.origin}${path}`
}

// The page a folder or file was published as with --save, kept in .the-artifact.json in the current
// folder so it can be committed and every later publish updates the same page
export const LINK_FILE = '.the-artifact.json'

type Links = { pages: Record<string, { id: string; server: string }> }

export function linkKey(cwd: string, target: string): string {
  const rel = relative(cwd, resolve(cwd, target)) || '.'
  return sep === '/' ? rel : rel.split(sep).join('/')
}

async function readLinks(cwd: string): Promise<Links> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, LINK_FILE), 'utf8')) as Links
    return { pages: parsed.pages && typeof parsed.pages === 'object' ? parsed.pages : {} }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { pages: {} }
    throw new CliError(`${join(cwd, LINK_FILE)} can't be read: fix or delete it.`)
  }
}

export async function readLink(cwd: string, target: string) {
  return (await readLinks(cwd)).pages[linkKey(cwd, target)] ?? null
}

export async function saveLink(cwd: string, target: string, link: { id: string; server: string }) {
  const links = await readLinks(cwd)
  links.pages[linkKey(cwd, target)] = link
  await writeFile(join(cwd, LINK_FILE), `${JSON.stringify(links, null, 2)}\n`)
}
