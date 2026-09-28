import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sendShareNotice } from '../../src/mail.js'
import { createToken, revokeToken } from '../../src/tokens.js'
import { approve, createUser, type TestUser } from './helpers.js'

// The CLI in packages/cli, run as its own process against this API listening on a real port. Node
// runs its TypeScript sources as they are, so nothing has to be built first.
const CLI = fileURLToPath(new URL('../../../../packages/cli/src/cli.ts', import.meta.url))

let server: ServerType
let origin: string
let tmp: string

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve())
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'artifact-cli-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

type Run = { code: number | null; stdout: string; stderr: string }

// Only what the CLI needs, so nothing from the test process (or the developer's own sign-in) leaks in
function cliEnv(extra: Record<string, string> = {}) {
  return { PATH: process.env.PATH ?? '', HOME: tmp, THE_ARTIFACT_CONFIG_DIR: join(tmp, 'config'), THE_ARTIFACT_URL: origin, CI: '1', ...extra }
}

function start(args: string[], opts: { env?: Record<string, string>; cwd?: string; stdin?: string } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? tmp, env: cliEnv(opts.env) })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => {
    out.stdout += d
  })
  child.stderr.on('data', (d) => {
    out.stderr += d
  })
  child.stdin.end(opts.stdin ?? '')
  const done = new Promise<Run>((resolve) => child.on('close', (code) => resolve({ code, ...out })))
  return { child, out, done }
}

// Never spawnSync: the API answering the CLI runs in this process
const run = (args: string[], opts: Parameters<typeof start>[1] = {}) => start(args, opts).done

async function site(files: Record<string, string>) {
  const dir = join(tmp, 'site')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

async function tokenFor(user: TestUser, name = 'GitHub Actions') {
  return createToken({ userId: user.id, organizationId: null, name, expiresAt: null })
}

const lastLine = (text: string) => text.trimEnd().split('\n').at(-1)

const pageId = (url: string) => url.trim().match(/\/a\/([a-z0-9]+)$/)![1]

async function pageBySlug(slug: string) {
  const [page] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
  return page
}

describe('the-artifact publish', () => {
  it('publishes a folder with an access token and prints only the link', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const dir = await site({
      'index.html': '<!doctype html><title>Test &amp; coverage</title><link rel="stylesheet" href="css/site.css"><h1>Green</h1>',
      'css/site.css': 'h1 { color: green }',
      'img/logo.png': 'not really a png',
      '.env': 'SECRET=1',
      'node_modules/x/index.js': 'nope',
      'report.gz': 'compressed',
    })

    const res = await run(['publish', dir], { env: { THE_ARTIFACT_TOKEN: token } })
    expect(res.stderr).toContain('Left out report.gz')
    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/^http:\/\/localhost:5177\/a\/[a-z0-9]+\n$/)
    expect(res.stderr).toContain('Published "Test & coverage"')

    const page = await pageBySlug(pageId(res.stdout))
    expect(page).toMatchObject({ title: 'Test & coverage', currentVersion: 1, ownerId: user.id, visibility: 'private' })
    const [version] = await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, page.id))
    expect(version.publishedWith).toBe('GitHub Actions')
    const files = await db.select({ path: schema.artifactFiles.path }).from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, version.id))
    expect(files.map((f) => f.path).sort()).toEqual(['css/site.css', 'img/logo.png'])
  })

  it('publishes new versions with --id, and with the page --save remembered', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const dir = await site({ 'index.html': '<!doctype html><h1>One</h1>' })
    const env = { THE_ARTIFACT_TOKEN: token }

    const first = await run(['publish', 'site', '--title', 'Nightly', '--json', '--save', '--visibility', 'link'], { env })
    expect(first.code).toBe(0)
    const published = JSON.parse(first.stdout)
    expect(published).toMatchObject({ title: 'Nightly', version: 1, visibility: 'link', folder: null })
    expect(JSON.parse(await readFile(join(tmp, '.the-artifact.json'), 'utf8'))).toEqual({ pages: { site: { id: published.id, server: origin } } })

    await writeFile(join(dir, 'index.html'), '<!doctype html><h1>Two</h1>')
    const second = await run(['publish', 'site', '--title', 'Nightly', '--folder', 'Reports'], { env })
    expect(second.code).toBe(0)
    expect(second.stderr).toContain('Published version 2 of "Nightly"')
    expect(pageId(second.stdout)).toBe(published.id)

    const third = await run(['publish', 'site', '--title', 'Nightly', '--id', published.url], { env })
    expect(third.stderr).toContain('Published version 3 of "Nightly"')

    const fresh = await run(['publish', 'site', '--new'], { env })
    expect(fresh.code).toBe(0)
    expect(pageId(fresh.stdout)).not.toBe(published.id)
    // No <title>: the folder's name
    expect((await pageBySlug(pageId(fresh.stdout))).title).toBe('site')
  })

  it('updates only the files named with --only, and removes files with --remove', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const env = { THE_ARTIFACT_TOKEN: token }
    const dir = await site({
      'index.html': '<!doctype html><title>Dashboard</title><script src="app.js"></script>',
      'app.js': 'fetch("data.json")',
      'data.json': '{"visitors":1}',
      'old.css': 'h1 {}',
    })
    const first = await run(['publish', 'site', '--save'], { env })
    expect(first.code).toBe(0)
    const page = await pageBySlug(pageId(first.stdout))

    await writeFile(join(dir, 'data.json'), '{"visitors":2}')
    // Changed too, but not named: stays as it was on the server
    await writeFile(join(dir, 'app.js'), 'broken(')
    const second = await run(['publish', 'site', '--only', 'data.json'], { env })
    expect(second.code).toBe(0)
    expect(second.stderr).toContain(`Updating ${page.slug}: data.json (14 B).`)
    expect(second.stderr).toContain('Published version 2 of "Dashboard"')
    expect(pageId(second.stdout)).toBe(page.slug)

    const files = async (version: number) => {
      const [v] = await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.version, version))
      const rows = await db.select().from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, v.id))
      return { version: v, paths: rows.map((r) => r.path).sort() }
    }
    const v2 = await files(2)
    expect(v2.paths).toEqual(['app.js', 'data.json', 'old.css'])
    expect(v2.version.publishedWith).toBe('GitHub Actions')
    const served = async (path: string) => (await app.request(`/api/artifacts/${page.slug}/v/2/${path}`, { headers: { cookie: user.cookie } })).text()
    expect(await served('data.json')).toBe('{"visitors":2}')
    expect(await served('app.js')).toBe('fetch("data.json")')

    // A job's folder can hold only the data, and the page is named by --id
    const job = join(tmp, 'job')
    await mkdir(job)
    await writeFile(join(job, 'data.json'), '{"visitors":3}')
    const third = await run(['publish', 'job', '--id', page.slug, '--only', 'data.json', '--remove', 'old.css', '--json'], { env })
    expect(third.code).toBe(0)
    expect(JSON.parse(third.stdout)).toMatchObject({ id: page.slug, version: 3, title: 'Dashboard' })
    expect((await files(3)).paths).toEqual(['app.js', 'data.json'])

    const entry = await run(['publish', 'job', '--id', page.slug, '--remove', 'index.html'], { env })
    expect(entry.code).toBe(1)
    expect(lastLine(entry.stderr)).toBe("index.html is the page itself, so it can't be removed. Send a new index.html instead.")
  })

  it("shows the server's message when it refuses the page", async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const res = await run(['publish', 'site', '--id', 'nosuchpage'], { env: { THE_ARTIFACT_TOKEN: token } })
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('Publishing a new version of "site": index.html, 25 B.\n')
    expect(lastLine(res.stderr)).toMatch(/^No page you can edit has the id "nosuchpage"/)
  })

  it('refuses a revoked token clearly', async () => {
    const user = await createUser()
    const { token, row } = await tokenFor(user)
    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    expect(await revokeToken(row.id, { userId: user.id })).toBe(true)

    const res = await run(['publish', 'site'], { env: { THE_ARTIFACT_TOKEN: token } })
    expect(res.code).toBe(1)
    expect(lastLine(res.stderr)).toBe('The access token in THE_ARTIFACT_TOKEN was refused. It may have expired or been revoked.')
    const listed = await run(['list', '--token', token])
    expect(listed.code).toBe(1)
    expect(listed.stderr).toBe('The access token passed with --token was refused. It may have expired or been revoked.\n')
  })

  it('needs a sign-in, and goes to the hosted service without a server', async () => {
    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const noServer = await run(['publish', 'site'], { env: { THE_ARTIFACT_URL: '' } })
    expect(noServer.code).toBe(1)
    expect(noServer.stderr).toContain("You're not signed in to https://the-artifact-pi.vercel.app")
    const notSignedIn = await run(['publish', 'site'])
    expect(notSignedIn.code).toBe(1)
    expect(notSignedIn.stderr).toContain(`You're not signed in to ${origin}`)
  })
})

describe('the-artifact publish --watch', () => {
  afterEach(() => {
    env.storage.publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? ''
  })

  // Each change waits for a poll (1 s) and the debounce (0.5 s) before it publishes, so a test with a
  // few changes outlasts vitest's 5 s default on a busy runner; the tests get 30 s
  async function until(check: () => boolean, what: string) {
    const end = Date.now() + 15_000
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  async function versions(slug: string) {
    const page = await pageBySlug(slug)
    return db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, page.id)).orderBy(schema.artifactVersions.version)
  }

  it('publishes new versions of the same page as files change, uploading only what changed, until Ctrl+C', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const id = crypto.randomUUID()
    const dir = await site({
      'index.html': `<!doctype html><title>Live</title><link rel="stylesheet" href="site.css"><h1>${id}</h1>`,
      'site.css': `/* ${id} */`,
    })
    const watch = start(['publish', 'site', '--watch'], { env: { THE_ARTIFACT_TOKEN: token } })
    await until(() => watch.out.stderr.includes('Watching site for changes'), 'the first publish')
    const slug = pageId(watch.out.stdout)

    await writeFile(join(dir, 'site.css'), `/* ${id} */ h1 { color: green }`)
    await until(() => watch.out.stderr.includes('Published version 2 of "Live"'), 'version 2')
    expect(watch.out.stderr).toContain('Sent 1 of 2 files; the others were already stored.')
    // Hidden files never publish
    await writeFile(join(dir, '.notes'), 'x')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await versions(slug)).toHaveLength(2)

    watch.child.kill('SIGINT')
    const res = await watch.done
    expect(res.code).toBe(0)
    expect(res.stderr).toContain('Stopped watching.')
    expect(res.stdout.trim().split('\n').map(pageId)).toEqual([slug, slug])
    const [, second] = await versions(slug)
    expect(second.publishedWith).toBe('GitHub Actions')
  }, 30_000)

  it('sends whole pages to a server without direct uploads, and keeps going after a refused one', async () => {
    env.storage.publicEndpoint = ''
    const user = await createUser()
    const { token } = await tokenFor(user)
    const dir = await site({ 'index.html': '<!doctype html><title>Plain</title><h1>One</h1>' })
    const watch = start(['publish', 'site', '--watch', '--json'], { env: { THE_ARTIFACT_TOKEN: token } })
    await until(() => watch.out.stderr.includes('Watching site'), 'the first publish')
    const first = JSON.parse(watch.out.stdout.trim())
    expect(first).toMatchObject({ title: 'Plain', version: 1 })

    // An empty page is refused; the watch reports it and waits
    await writeFile(join(dir, 'index.html'), '')
    await until(() => watch.out.stderr.includes('index.html is empty.'), 'the refusal')
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>Plain</title><h1>Two</h1>')
    await until(() => watch.out.stdout.trim().split('\n').length === 2, 'version 2')
    expect(JSON.parse(watch.out.stdout.trim().split('\n')[1])).toMatchObject({ id: first.id, version: 2 })

    watch.child.kill('SIGINT')
    expect((await watch.done).code).toBe(0)
  }, 30_000)
})

describe('the-artifact list and share', () => {
  it('lists pages as a table and as JSON', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const env = { THE_ARTIFACT_TOKEN: token }
    const empty = await run(['list'], { env })
    expect(empty).toMatchObject({ code: 0, stdout: '', stderr: 'No pages yet.\n' })
    expect(JSON.parse((await run(['list', '--json'], { env })).stdout)).toEqual({ pages: [], total: 0, cursor: null })

    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const a = await run(['publish', 'site', '--title', 'Coverage report', '--folder', 'Reports'], { env })
    await run(['publish', 'site', '--title', 'Launch plan'], { env })

    const table = await run(['list'], { env })
    expect(table.code).toBe(0)
    const lines = table.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^ID\s+VERSION\s+ACCESS\s+FOLDER\s+TITLE$/)
    expect(lines[1]).toMatch(/Launch plan$/)
    expect(lines[2]).toContain(pageId(a.stdout))
    expect(lines[2]).toMatch(/Restricted\s+Reports\s+Coverage report$/)

    const json = await run(['list', '--json', '--query', 'coverage'], { env })
    expect(JSON.parse(json.stdout)).toEqual({
      pages: [
        {
          id: pageId(a.stdout),
          title: 'Coverage report',
          url: a.stdout.trim(),
          version: 1,
          visibility: 'private',
          folder: 'Reports',
          tags: [],
          updated_at: expect.any(String),
        },
      ],
      total: 1,
      cursor: null,
    })

    const paged = await run(['list', '--limit', '1', '--json'], { env })
    const first = JSON.parse(paged.stdout)
    expect(first.pages).toHaveLength(1)
    expect(first.total).toBe(2)
    const next = await run(['list', '--limit', '1', '--cursor', first.cursor, '--json'], { env })
    expect(JSON.parse(next.stdout).pages[0].title).toBe('Coverage report')

    const bad = await run(['list', '--limit', '500'], { env })
    expect(bad.code).toBe(2)
  })

  it('changes who can open a page and shares it by email', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const env = { THE_ARTIFACT_TOKEN: token }
    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const url = (await run(['publish', 'site', '--title', 'Plan'], { env })).stdout.trim()

    const link = await run(['share', url, '--visibility', 'link'], { env })
    expect(link.code).toBe(0)
    expect(link.stdout).toContain('"Plan" is now')
    expect((await pageBySlug(pageId(url))).visibility).toBe('link')

    const people = await run(['share', pageId(url), '--email', 'ana@example.com', '--email', 'bo@example.com', '--role', 'editor', '--json'], { env })
    expect(people.code).toBe(0)
    expect(JSON.parse(people.stdout).messages[0]).toContain('Shared "Plan" with ana@example.com, bo@example.com as editor.')
    const shares = await db.select().from(schema.artifactShares)
    expect(shares.map((s) => [s.email, s.role]).sort()).toEqual([
      ['ana@example.com', 'editor'],
      ['bo@example.com', 'editor'],
    ])
    expect(sendShareNotice).toHaveBeenCalled()

    const personal = await run(['share', pageId(url), '--visibility', 'org'], { env })
    expect(personal.code).toBe(1)
    expect(personal.stderr).toBe('This page is in a personal workspace. Use private (restricted) or link.\n')

    const nothing = await run(['share', pageId(url)], { env })
    expect(nothing.code).toBe(2)
  })

  it('sets an expiry and a password on the link, and makes a new link', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user)
    const env = { THE_ARTIFACT_TOKEN: token }
    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const url = (await run(['publish', 'site', '--title', 'Plan', '--visibility', 'link'], { env })).stdout.trim()

    const locked = await run(['share', url, '--expires', '2999-12-31', '--password', 'open sesame'], { env })
    expect(locked.code).toBe(0)
    expect(locked.stdout).toContain('(until 2999-12-31 23:59 UTC, with a password)')
    const page = await pageBySlug(pageId(url))
    expect(page.linkExpiresAt?.toISOString()).toBe('2999-12-31T23:59:59.999Z')
    expect(page.linkPasswordHash).toMatch(/^scrypt\$/)

    // The page keeps its id; only the public link changes
    const slug = pageId(url)
    const rotated = await run(['share', slug, '--new-link', '--email', 'ana@example.com', '--json'], { env })
    expect(rotated.code).toBe(0)
    const [linkMessage, shareMessage] = JSON.parse(rotated.stdout).messages
    const { linkToken } = await pageBySlug(slug)
    expect(linkMessage).toContain(`Public link: ${url}?k=${linkToken}`)
    expect(shareMessage).toContain(`/a/${slug}`)

    const cleared = await run(['share', slug, '--expires', 'never', '--password', ''], { env })
    expect(cleared.code).toBe(0)
    expect((await pageBySlug(slug)).linkPasswordHash).toBeNull()
  })
})

describe('the-artifact login', () => {
  // Plays the browser: follows the sign-in link the CLI prints, approves on the consent API as the
  // person, and lands on the CLI's loopback address with the code
  async function signInWithBrowser(user: TestUser, extra: string[] = []) {
    const login = start(['login', ...extra])
    const link = await new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        const found = login.out.stderr.match(/(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)/)
        if (found) {
          clearInterval(timer)
          resolve(found[1])
        }
      }, 20)
      login.done.then((r) => {
        clearInterval(timer)
        reject(new Error(`login exited early: ${r.stderr}`))
      })
    })
    const authorize = await fetch(link, { redirect: 'manual' })
    expect(authorize.status).toBe(302)
    const consent = new URL(authorize.headers.get('location')!)
    const { redirect } = await approve(user, consent.searchParams.get('request')!)
    expect(redirect.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const back = await fetch(redirect)
    expect(back.status).toBe(200)
    expect(await back.text()).toContain('You are signed in')
    return login.done
  }

  it('signs in with the browser, publishes as The Artifact CLI, refreshes, and signs out', async () => {
    const user = await createUser({ name: 'Ana' })
    const res = await signInWithBrowser(user)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe(`Signed in to ${origin} as ${user.email}, publishing to Personal.\n`)

    const credsPath = join(tmp, 'config', 'credentials.json')
    const creds = JSON.parse(await readFile(credsPath, 'utf8'))
    expect(creds.default).toBe(origin)
    expect(creds.servers[origin]).toMatchObject({ kind: 'oauth', clientId: expect.any(String), accessToken: expect.any(String) })
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      expect((await stat(credsPath)).mode & 0o777).toBe(0o600)
    }

    // No THE_ARTIFACT_URL: the server signed in to is the default
    const me = await run(['whoami', '--json'], { env: { THE_ARTIFACT_URL: '' } })
    expect(JSON.parse(me.stdout)).toEqual({
      server: origin,
      email: user.email,
      name: 'Ana',
      workspace: { id: null, name: 'Personal' },
      client: 'The Artifact CLI',
    })

    await site({ 'index.html': '<!doctype html><h1>x</h1>' })
    const published = await run(['publish', 'site'])
    expect(published.code).toBe(0)
    const [version] = await db.select().from(schema.artifactVersions)
    expect(version.publishedWith).toBe('The Artifact CLI')

    // An expired access token is refreshed, and the new tokens saved
    creds.servers[origin].expiresAt = Date.now() - 1000
    await writeFile(credsPath, JSON.stringify(creds))
    const listed = await run(['list', '--json'])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout).pages).toHaveLength(1)
    const after = JSON.parse(await readFile(credsPath, 'utf8')).servers[origin]
    expect(after.refreshToken).not.toBe(creds.servers[origin].refreshToken)
    expect(after.expiresAt).toBeGreaterThan(Date.now())

    const out = await run(['logout'])
    expect(out.stdout).toBe(`Signed out of ${origin}.\n`)
    // Disconnected on the server too, so it leaves Connected agents
    expect(await db.select().from(schema.oauthTokens)).toHaveLength(0)
    expect(JSON.parse(await readFile(credsPath, 'utf8')).servers).toEqual({})
    const gone = await run(['list'])
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain("You're not signed in")
  })

  it('ends with a clear message when a saved sign-in no longer works', async () => {
    const user = await createUser()
    expect((await signInWithBrowser(user)).code).toBe(0)
    // Disconnected in settings
    await db.delete(schema.oauthTokens)
    const res = await run(['list'])
    expect(res.code).toBe(1)
    expect(res.stderr).toBe(`Your sign-in to ${origin} has ended. Run the-artifact login to sign in again.\n`)
  })

  it('saves an access token read from standard input', async () => {
    const user = await createUser()
    const { token } = await tokenFor(user, 'Laptop')
    const res = await run(['login', '--with-token'], { stdin: `${token}\n` })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe(`Signed in to ${origin} as ${user.email}, publishing to Personal.\n`)
    const me = await run(['whoami'])
    expect(me.stdout).toBe(`${user.email} in Personal on ${origin}\n`)

    const wrong = await run(['login', '--with-token'], { stdin: 'art_nottherightlength' })
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('refused')
  })
})
