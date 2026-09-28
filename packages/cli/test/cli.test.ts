import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorMessage, lastEvent, VERSION } from '../src/api.ts'
import { resolveAuth, resolveServer } from '../src/auth.ts'
import { configDir, linkKey, normalizeServer, readCredentials, readLink, saveLink, writeCredentials } from '../src/config.ts'
import { UsageError } from '../src/errors.ts'
import { type Io, main, parse, visibilityArg } from '../src/main.ts'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'artifact-cli-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function io(env: Record<string, string> = {}) {
  const out = { stdout: '', stderr: '' }
  const value: Io = {
    env: { THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config'), ...env },
    cwd: tmp,
    stdout: { write: (s: string) => (out.stdout += s) },
    stderr: { write: (s: string) => (out.stderr += s) },
    readStdin: async () => '',
    openBrowser: false,
  }
  return { io: value, out }
}

describe('parse', () => {
  it('reads a command with its options', () => {
    expect(parse(['publish', 'dist', '--title', 'Report', '--ignore', '*.map', '--ignore', 'drafts/', '--json'])).toEqual({
      command: 'publish',
      positionals: ['dist'],
      values: { title: 'Report', ignore: ['*.map', 'drafts/'], json: true },
    })
  })

  it('shows help and the version', () => {
    expect(parse([])).toMatchObject({ help: expect.stringContaining('Usage: the-artifact <command>') })
    expect(parse(['help', 'publish'])).toMatchObject({ help: expect.stringContaining('Usage: the-artifact publish') })
    expect(parse(['share', '--help'])).toMatchObject({ help: expect.stringContaining('Usage: the-artifact share') })
    expect(parse(['--version'])).toEqual({ version: true })
  })

  it('refuses unknown commands and options', () => {
    expect(() => parse(['pubish'])).toThrow(UsageError)
    expect(() => parse(['publish', '--titel', 'x'])).toThrow("Unknown option '--titel'. Run the-artifact publish --help.")
    expect(() => parse(['list', '--query'])).toThrow(UsageError)
  })
})

describe('visibilityArg', () => {
  it('takes the names the app uses, and the API names', () => {
    expect(visibilityArg('Restricted')).toBe('private')
    expect(visibilityArg('private')).toBe('private')
    expect(visibilityArg('org')).toBe('organization')
    expect(visibilityArg('link')).toBe('link')
    expect(visibilityArg(undefined)).toBeUndefined()
    expect(() => visibilityArg('public')).toThrow('--visibility is restricted, organization or link, not "public".')
  })
})

describe('servers and credentials', () => {
  it('normalizes server addresses', () => {
    expect(normalizeServer('https://artifact.example.com/')).toBe('https://artifact.example.com')
    expect(normalizeServer('https://artifact.example.com/mcp')).toBe('https://artifact.example.com')
    expect(normalizeServer('artifact.example.com')).toBe('https://artifact.example.com')
    expect(normalizeServer('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeServer('https://example.com/artifact/')).toBe('https://example.com/artifact')
    expect(() => normalizeServer('ftp://example.com')).toThrow("isn't an http or https address")
  })

  it('keeps credentials in the config folder, readable by the owner only', async () => {
    const env = { THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config') }
    expect(await readCredentials(env)).toEqual({ servers: {} })
    await writeCredentials(env, { default: 'https://a.example', servers: { 'https://a.example': { kind: 'token', token: 'art_x' } } })
    await writeCredentials(env, { default: 'https://a.example', servers: { 'https://a.example': { kind: 'token', token: 'art_y' } } })
    const path = join(tmp, 'config', 'credentials.json')
    expect(JSON.parse(await readFile(path, 'utf8')).servers['https://a.example'].token).toBe('art_y')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('finds the config folder for each platform', () => {
    expect(configDir({ THE_ARTIFACT_CONFIG_DIR: '/x' })).toBe('/x')
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toContain('the-artifact')
    expect(configDir({ XDG_CONFIG_HOME: '/home/a/.cfg' }, 'linux')).toBe('/home/a/.cfg/the-artifact')
  })

  it('takes the server from the flag, the environment, the last sign-in, then the hosted service', async () => {
    const env = { THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config') }
    expect(await resolveServer(undefined, env)).toBe('https://the-artifact-pi.vercel.app')
    await writeCredentials(env, { default: 'https://saved.example', servers: {} })
    expect(await resolveServer(undefined, env)).toBe('https://saved.example')
    expect(await resolveServer(undefined, { ...env, THE_ARTIFACT_URL: 'https://env.example/' })).toBe('https://env.example')
    expect(await resolveServer('flag.example', { ...env, THE_ARTIFACT_URL: 'https://env.example' })).toBe('https://flag.example')
  })

  it('prefers --token, then THE_ARTIFACT_TOKEN, then a saved sign-in', async () => {
    const env = { THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config') }
    await expect(resolveAuth('https://a.example', { env })).rejects.toThrow("You're not signed in to https://a.example")
    await writeCredentials(env, { servers: { 'https://a.example': { kind: 'token', token: 'art_saved' } } })
    expect(await (await resolveAuth('https://a.example', { env })).bearer()).toBe('art_saved')
    const fromEnv = await resolveAuth('https://a.example', { env: { ...env, THE_ARTIFACT_TOKEN: ' art_env\n' } })
    expect([fromEnv.source, await fromEnv.bearer()]).toEqual(['env', 'art_env'])
    const fromFlag = await resolveAuth('https://a.example', { token: 'art_flag', env: { ...env, THE_ARTIFACT_TOKEN: 'art_env' } })
    expect([fromFlag.source, await fromFlag.bearer()]).toEqual(['flag', 'art_flag'])
  })

  it('remembers pages by path, relative to the current folder', async () => {
    expect(linkKey(tmp, join(tmp, 'dist'))).toBe('dist')
    expect(linkKey(tmp, tmp)).toBe('.')
    expect(await readLink(tmp, 'dist')).toBeNull()
    await saveLink(tmp, join(tmp, 'dist'), { id: 'k3v9x2m8pq', server: 'https://a.example' })
    expect(await readLink(tmp, 'dist')).toEqual({ id: 'k3v9x2m8pq', server: 'https://a.example' })
  })
})

describe('server answers', () => {
  it('reads the last JSON-RPC message of an event stream', () => {
    const stream =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n: keep-alive\n\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[]}}\n\n'
    expect(lastEvent(stream)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    expect(lastEvent('')).toBeNull()
  })

  it("shows the server's own message", () => {
    const res = new Response(null, { status: 400 })
    expect(errorMessage({ error: 'Give the page a title.', field: 'title' }, res)).toBe('Give the page a title.')
    expect(errorMessage({ error: 'invalid_grant', error_description: 'The refresh token is invalid or expired.' }, res)).toBe(
      'The refresh token is invalid or expired.',
    )
  })
})

describe('main', () => {
  it('prints help and the version, and exits 2 on wrong usage', async () => {
    const help = io()
    expect(await main(['--help'], help.io)).toBe(0)
    expect(help.out.stdout).toContain('Commands:')
    const version = io()
    expect(await main(['--version'], version.io)).toBe(0)
    expect(version.out.stdout).toBe(`${VERSION}\n`)
    const wrong = io()
    expect(await main(['publish'], wrong.io)).toBe(2)
    expect(wrong.out.stderr).toBe('Say which folder: the-artifact publish <folder>.\n')
  })

  it('lists what a dry run would send, without a server', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tmp, 'index.html'), '<title>Dry</title>')
    const run = io()
    expect(await main(['publish', '.', '--dry-run', '--json'], run.io)).toBe(0)
    expect(JSON.parse(run.out.stdout)).toEqual({ title: 'Dry', entry: 'index.html', files: [], total: 18 })
  })
})
