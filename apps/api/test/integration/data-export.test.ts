import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { buildExport, buildExportsInProcess, EXPORT_HOURS, stepExport, sweepExports, zipKey } from '../../src/exports.js'
import { sendExportReady } from '../../src/mail.js'
import { deleteObjects, getObject, listObjects } from '../../src/storage.js'
import { unzip } from '../unzip.js'
import { addMember, call, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

type ExportView = {
  id: string
  status: 'building' | 'ready' | 'failed'
  pagesDone: number
  pagesTotal: number
  expiresAt: string | null
  downloadUrl: string | null
  buildsOnPoll: boolean
}

async function site(owner: TestUser, html: string, opts: { slug?: string; organizationId?: string | null; title?: string } = {}) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId: opts.organizationId ?? null,
    clientName: 'test-client',
    title: opts.title ?? 'Signups by week',
    html,
    files: [
      { path: 'css/site.css', content: 'body { color: red }' },
      { path: 'img/dot.png', content: PNG.toString('base64'), encoding: 'base64' },
    ],
    slug: opts.slug,
  })
}

async function requestExport(user: TestUser, body: { organizationId?: string | null; versions: 'all' | 'current' }) {
  return call('/api/exports', { cookie: user.cookie, json: body })
}

async function current(user: TestUser, organizationId?: string): Promise<ExportView | null> {
  const res = await call(`/api/exports${organizationId ? `?organizationId=${organizationId}` : ''}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return ((await res.json()) as { export: ExportView | null }).export
}

// Builds it to the end and downloads it the way a browser would: the API's link, then the bucket's
async function exportOf(user: TestUser, body: { organizationId?: string | null; versions: 'all' | 'current' }) {
  const res = await requestExport(user, body)
  expect(res.status).toBe(202)
  const { export: created } = (await res.json()) as { export: ExportView }
  expect(created.status).toBe('building')
  expect(await buildExport(created.id)).toBe('done')
  const ready = await current(user, body.organizationId ?? undefined)
  expect(ready?.status).toBe('ready')
  return { view: ready!, files: await download(user, ready!.downloadUrl!) }
}

async function download(user: TestUser, url: string) {
  const res = await call(url, { cookie: user.cookie })
  expect(res.status).toBe(302)
  const bucket = await fetch(res.headers.get('location')!)
  expect(bucket.status).toBe(200)
  expect(bucket.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9-]+-export-\d{4}-\d\d-\d\d\.zip"$/)
  return Object.fromEntries(unzip(Buffer.from(await bucket.arrayBuffer())).map((e) => [e.path, e.content]))
}

const parse = (files: Record<string, Buffer>, path: string) => JSON.parse(files[path].toString('utf8'))

afterEach(() => {
  env.storage.publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? ''
  env.smtp.host = 'localhost'
})

describe('exporting an account', () => {
  it('holds the account, every page with its versions, sharing and comments, and comments written elsewhere', async () => {
    const me = await createUser({ email: 'me@example.com', name: 'Me Myself' })
    const friend = await createUser({ email: 'friend@example.com', name: 'Friend' })
    const org = await createOrg(me)

    const mine = await site(me, '<h1>v1</h1>')
    await site(me, '<h1>v2</h1>', { slug: mine.slug })
    const inOrg = await createPage(me, { organizationId: org.id, title: 'Roadmap' })
    const theirs = await createPage(friend, { title: 'Friend page' })
    await db
      .update(schema.artifacts)
      .set({ visibility: 'link', linkToken: 'secret-link-key-123', linkPasswordHash: 'scrypt$secret-hash' })
      .where(eq(schema.artifacts.id, mine.id))
    await db.update(schema.users).set({ passwordHash: 'scrypt$my-password-hash' }).where(eq(schema.users.id, me.id))

    expect(
      (await call(`/api/artifacts/${mine.slug}/sharing/people`, { cookie: me.cookie, json: { emails: [friend.email], role: 'viewer', notify: false } })).status,
    ).toBe(200)
    expect((await call(`/api/artifacts/${mine.slug}/comments`, { cookie: friend.cookie, json: { body: 'Nice chart' } })).status).toBe(201)
    await db.insert(schema.artifactShares).values({ artifactId: theirs.id, email: me.email, role: 'viewer' })
    expect((await call(`/api/artifacts/${theirs.slug}/comments`, { cookie: me.cookie, json: { body: 'My note elsewhere' } })).status).toBe(201)

    const tokenRes = await call('/api/me/access-tokens', { cookie: me.cookie, json: { name: 'CI deploy', organizationId: null } })
    const { token } = (await tokenRes.json()) as { token: string }
    const agent = await connectAgent(me)

    const { files } = await exportOf(me, { versions: 'all' })
    const paths = Object.keys(files).sort()
    expect(paths).toEqual(
      [
        'README.txt',
        'account.json',
        'comments.json',
        `pages/${mine.slug}/page.json`,
        `pages/${mine.slug}/comments.json`,
        `pages/${mine.slug}/versions/1/index.html`,
        `pages/${mine.slug}/versions/1/css/site.css`,
        `pages/${mine.slug}/versions/1/img/dot.png`,
        `pages/${mine.slug}/versions/2/index.html`,
        `pages/${mine.slug}/versions/2/css/site.css`,
        `pages/${mine.slug}/versions/2/img/dot.png`,
        `pages/${inOrg.slug}/page.json`,
        `pages/${inOrg.slug}/comments.json`,
        `pages/${inOrg.slug}/versions/1/index.html`,
      ].sort(),
    )
    expect(files[`pages/${mine.slug}/versions/1/index.html`].toString()).toBe('<h1>v1</h1>')
    expect(files[`pages/${mine.slug}/versions/2/img/dot.png`].equals(PNG)).toBe(true)
    expect(files['README.txt'].toString()).toContain('me@example.com')

    const account = parse(files, 'account.json')
    expect(account.account).toMatchObject({ email: 'me@example.com', name: 'Me Myself' })
    expect(account.signIn.password).toBe(true)
    expect(account.organizations).toEqual([expect.objectContaining({ name: 'Acme Inc', role: 'owner' })])
    expect(account.accessTokens).toEqual([expect.objectContaining({ name: 'CI deploy', workspace: 'Personal' })])
    expect(account.connectedAgents).toEqual([expect.objectContaining({ name: 'claude-code', workspace: 'Personal' })])
    expect(account.sessions.length).toBeGreaterThan(0)

    const page = parse(files, `pages/${mine.slug}/page.json`)
    expect(page).toMatchObject({ title: 'Signups by week', workspace: 'Personal', currentVersion: 2, generalAccess: 'anyone with the link' })
    expect(page.link).toEqual({ on: true, expiresAt: null, passwordProtected: true, hasKey: true })
    expect(page.sharedWith).toEqual([expect.objectContaining({ email: 'friend@example.com', role: 'viewer' })])
    expect(page.versions.map((v: { version: number; publishedBy: string; included: boolean }) => [v.version, v.publishedBy, v.included])).toEqual([
      [1, 'Me Myself', true],
      [2, 'Me Myself', true],
    ])
    expect(parse(files, `pages/${inOrg.slug}/page.json`).workspace).toBe('Acme Inc')

    const comments = parse(files, `pages/${mine.slug}/comments.json`)
    expect(comments).toEqual([expect.objectContaining({ author: 'Friend', byYou: false, body: 'Nice chart', version: 2 })])
    const elsewhere = parse(files, 'comments.json')
    expect(elsewhere).toEqual([
      expect.objectContaining({ body: 'My note elsewhere', page: expect.objectContaining({ slug: theirs.slug, title: 'Friend page' }) }),
    ])

    // No secrets anywhere, and commenters only by name
    const everything = Object.values(files)
      .map((b) => b.toString('latin1'))
      .join('\n')
    for (const secret of [token, agent.access_token, agent.refresh_token, 'secret-link-key-123', 'scrypt$', me.cookie.slice('session='.length)]) {
      expect(everything).not.toContain(secret)
    }
    expect(files[`pages/${mine.slug}/comments.json`].toString()).not.toContain('friend@example.com')
  })

  it('can hold only the current version of each page, still listing them all', async () => {
    const me = await createUser()
    const page = await site(me, '<h1>v1</h1>')
    await site(me, '<h1>v2</h1>', { slug: page.slug })
    const { files } = await exportOf(me, { versions: 'current' })
    expect(Object.keys(files).filter((p) => p.includes('/versions/'))).toEqual(
      expect.arrayContaining([`pages/${page.slug}/versions/2/index.html`, `pages/${page.slug}/versions/2/css/site.css`]),
    )
    expect(Object.keys(files).some((p) => p.includes('/versions/1/'))).toBe(false)
    expect(parse(files, `pages/${page.slug}/page.json`).versions.map((v: { included: boolean }) => v.included)).toEqual([false, true])
    expect(files['README.txt'].toString()).toContain('Only the current version')
  })

  it('names a page commented on elsewhere only while it can still be opened', async () => {
    const me = await createUser()
    const friend = await createUser()
    const theirs = await createPage(friend, { title: 'Secret plans' })
    await db.insert(schema.artifactShares).values({ artifactId: theirs.id, email: me.email, role: 'viewer' })
    expect((await call(`/api/artifacts/${theirs.slug}/comments`, { cookie: me.cookie, json: { body: 'Hello' } })).status).toBe(201)
    await db.delete(schema.artifactShares).where(eq(schema.artifactShares.artifactId, theirs.id))
    const { files } = await exportOf(me, { versions: 'current' })
    expect(parse(files, 'comments.json')).toEqual([expect.objectContaining({ body: 'Hello', page: null })])
    expect(files['comments.json'].toString()).not.toContain('Secret plans')
  })

  it('builds in many small steps across parts of the upload, and the zip still opens', async () => {
    const me = await createUser()
    // Random bytes don't compress, so three versions make more than one 8 MB part
    const big = randomBytes(4 * 1024 * 1024)
    let page = await publish({
      userId: me.id,
      email: me.email,
      organizationId: null,
      clientName: 'test-client',
      title: 'Big',
      html: '<h1>1</h1>',
      files: [{ path: 'big.wasm', content: big.toString('base64'), encoding: 'base64' }],
    })
    for (const n of [2, 3])
      page = await publish({
        userId: me.id,
        email: me.email,
        organizationId: null,
        clientName: 'test-client',
        title: 'Big',
        html: `<h1>${n}</h1>`,
        slug: page.slug,
        files: [{ path: 'big.wasm', content: big.toString('base64'), encoding: 'base64' }],
      })
    await createPage(me, { title: 'Small' })

    const res = await requestExport(me, { versions: 'all' })
    const { export: created } = (await res.json()) as { export: ExportView }
    let steps = 0
    for (;;) {
      const result = await stepExport(created.id, 0)
      steps += 1
      if (result === 'done') break
      expect(result).toBe('more')
    }
    expect(steps).toBeGreaterThan(5)
    const [row] = await db.select().from(schema.dataExports).where(eq(schema.dataExports.id, created.id))
    expect((row.progress as { parts: unknown[] }).parts.length).toBeGreaterThan(1)
    // The pieces carried between steps are gone
    const left = []
    for await (const o of listObjects(`exports/${created.id}/`)) left.push(o.key)
    expect(left).toEqual([zipKey(created.id)])

    const ready = await current(me)
    const files = await download(me, ready!.downloadUrl!)
    for (const n of [1, 2, 3]) {
      expect(files[`pages/${page.slug}/versions/${n}/big.wasm`].equals(big)).toBe(true)
      expect(files[`pages/${page.slug}/versions/${n}/index.html`].toString()).toBe(`<h1>${n}</h1>`)
    }
    expect(ready!.pagesDone).toBe(2)
  })

  it('moves on each time its status is asked for when no process builds it', async () => {
    const me = await createUser()
    await createPage(me)
    const res = await requestExport(me, { versions: 'current' })
    expect(res.status).toBe(202)
    expect(((await res.json()) as { export: ExportView }).export.buildsOnPoll).toBe(true)
    const ready = await current(me)
    expect(ready?.status).toBe('ready')
    expect(ready?.downloadUrl).toMatch(new RegExp(`^/api/exports/${ready!.id}/download\\?sig=`))
  })

  it('tells the settings page it may be closed when the server builds exports by itself', async () => {
    const me = await createUser()
    await createPage(me)
    expect(((await (await requestExport(me, { versions: 'current' })).json()) as { export: ExportView }).export.buildsOnPoll).toBe(true)
    buildExportsInProcess()
    try {
      expect((await current(me))?.buildsOnPoll).toBe(false)
    } finally {
      buildExportsInProcess(false)
    }
  })

  it('emails a link to settings when it is ready, and nothing without email', async () => {
    const me = await createUser({ email: 'mail@example.com' })
    await exportOf(me, { versions: 'current' })
    expect(sendExportReady).toHaveBeenCalledWith('mail@example.com', {
      organization: null,
      link: `${env.appUrl}/settings#export`,
      hours: EXPORT_HOURS,
    })

    const other = await createUser()
    env.smtp.host = ''
    await exportOf(other, { versions: 'current' })
    expect(sendExportReady).toHaveBeenCalledTimes(1)
  })

  it('streams through the API when browsers cannot reach the bucket', async () => {
    const me = await createUser()
    const page = await createPage(me)
    const res = await requestExport(me, { versions: 'current' })
    const { export: created } = (await res.json()) as { export: ExportView }
    await buildExport(created.id)
    const ready = await current(me)
    env.storage.publicEndpoint = ''
    const got = await call(ready!.downloadUrl!, { cookie: me.cookie })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('application/zip')
    expect(got.headers.get('cache-control')).toBe('private, no-store')
    expect(got.headers.get('content-disposition')).toMatch(/^attachment; filename="the-artifact-export-\d{4}-\d\d-\d\d\.zip"$/)
    const files = unzip(Buffer.from(await got.arrayBuffer())).map((e) => e.path)
    expect(files).toContain(`pages/${page.slug}/versions/1/index.html`)
  })
})

describe('who can download an export', () => {
  it('only the account that asked for it, signed in, with the signed link', async () => {
    const me = await createUser()
    const someone = await createUser()
    await createPage(me)
    const { view } = await exportOf(me, { versions: 'current' })
    const url = view.downloadUrl!

    expect((await call(url)).status).toBe(404)
    expect((await call(url, { cookie: someone.cookie })).status).toBe(404)
    expect((await call(url.replace(/sig=.*/, 'sig=forged'), { cookie: me.cookie })).status).toBe(404)
    expect((await call(url.replace(/sig=.*/, ''), { cookie: me.cookie })).status).toBe(404)
    expect((await call(`/api/exports/${crypto.randomUUID()}/download?sig=x`, { cookie: me.cookie })).status).toBe(404)
    expect((await call('/api/exports/not-a-uuid/download', { cookie: me.cookie })).status).toBe(404)
    expect(await current(someone)).toBeNull()
    expect((await call(url, { cookie: me.cookie })).status).toBe(302)
  })

  it('stops working after it expires, and the sweep deletes it', async () => {
    const me = await createUser()
    await createPage(me)
    const { view } = await exportOf(me, { versions: 'current' })
    const expiresAt = new Date(view.expiresAt!)
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan((EXPORT_HOURS - 1) * 3600_000)
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(EXPORT_HOURS * 3600_000)

    await db
      .update(schema.dataExports)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.dataExports.id, view.id))
    expect((await call(view.downloadUrl!, { cookie: me.cookie })).status).toBe(404)
    expect(await current(me)).toBeNull()

    expect(await getObject(zipKey(view.id))).not.toBeNull()
    await sweepExports()
    expect(await db.select().from(schema.dataExports)).toEqual([])
    expect(await getObject(zipKey(view.id))).toBeNull()
  })

  it('goes with the account when it is deleted', async () => {
    const me = await createUser({ email: 'leaving@example.com' })
    await createPage(me)
    const { view } = await exportOf(me, { versions: 'current' })
    expect((await call('/api/me', { method: 'DELETE', cookie: me.cookie, json: { confirmEmail: 'leaving@example.com' } })).status).toBe(204)
    expect(await getObject(zipKey(view.id))).toBeNull()
  })
})

describe('the export limit', () => {
  it('allows one export of an account an hour, and none while one is being built', async () => {
    const me = await createUser()
    await createPage(me)
    const first = await requestExport(me, { versions: 'current' })
    expect(first.status).toBe(202)
    const building = await requestExport(me, { versions: 'all' })
    expect(building.status).toBe(409)
    expect(((await building.json()) as { error: string }).error).toBe('An export is already being built. Wait for it to finish.')

    await buildExport(((await first.json()) as { export: ExportView }).export.id)
    const again = await requestExport(me, { versions: 'current' })
    expect(again.status).toBe(429)
    expect(again.headers.get('retry-after')).toBeTruthy()
    expect(((await again.json()) as { error: string }).error).toMatch(/^An export was made a short time ago\. Try again in \d+ minutes?\.$/)
  })

  it('gives up after a few failed tries, without counting against the limit', async () => {
    const me = await createUser()
    await createPage(me)
    const res = await requestExport(me, { versions: 'current' })
    const { export: created } = (await res.json()) as { export: ExportView }
    expect(await stepExport(created.id, 0)).toBe('more')
    // The bytes carried to the next step are lost
    const [row] = await db.select().from(schema.dataExports).where(eq(schema.dataExports.id, created.id))
    await deleteObjects([(row.progress as { carry: string }).carry])
    for (const expected of ['more', 'more', 'failed']) {
      await db.update(schema.dataExports).set({ leaseUntil: null }).where(eq(schema.dataExports.id, created.id))
      expect(await stepExport(created.id)).toBe(expected)
    }
    const failed = await current(me)
    expect(failed).toMatchObject({ status: 'failed', downloadUrl: null })
    const left = []
    for await (const o of listObjects(`exports/${created.id}/`)) left.push(o.key)
    expect(left).toEqual([])
    expect((await requestExport(me, { versions: 'current' })).status).toBe(202)
  })

  it('counts an account and an organization apart', async () => {
    const me = await createUser()
    const org = await createOrg(me)
    expect((await requestExport(me, { versions: 'current' })).status).toBe(202)
    expect((await requestExport(me, { organizationId: org.id, versions: 'current' })).status).toBe(202)
  })

  it('asks which versions to include', async () => {
    const me = await createUser()
    const res = await requestExport(me, { versions: 'some' as 'all' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Choose every version or only the current one.', field: 'versions' })
  })
})

describe('exporting an organization', () => {
  it('is for its owners: every page in it, its members and settings', async () => {
    const owner = await createUser({ email: 'owner@example.com', name: 'Olive Owner' })
    const admin = await createUser({ email: 'admin@example.com', name: 'Ada Admin' })
    const member = await createUser({ email: 'member@example.com' })
    const outsider = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, admin, 'admin')
    await addMember(org.id, member, 'member')

    const ownerPage = await createPage(owner, { organizationId: org.id, title: 'Owner page' })
    const memberPage = await createPage(member, { organizationId: org.id, title: 'Member draft' })
    const personal = await createPage(owner, { title: 'Personal' })

    for (const who of [admin, member, outsider]) {
      expect((await requestExport(who, { organizationId: org.id, versions: 'current' })).status).toBe(404)
      expect((await call(`/api/exports?organizationId=${org.id}`, { cookie: who.cookie })).status).toBe(404)
    }
    expect((await requestExport(owner, { organizationId: 'not-a-uuid', versions: 'current' })).status).toBe(404)

    const { view, files } = await exportOf(owner, { organizationId: org.id, versions: 'current' })
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['README.txt', 'organization.json', `pages/${ownerPage.slug}/page.json`, `pages/${memberPage.slug}/versions/1/index.html`]),
    )
    expect(Object.keys(files).some((p) => p.includes(personal.slug))).toBe(false)
    expect(Object.keys(files)).not.toContain('account.json')
    expect(Object.keys(files)).not.toContain('comments.json')

    const organization = parse(files, 'organization.json')
    expect(organization.organization).toMatchObject({ name: 'Acme Inc', slug: 'acme', requireTwoFactor: false })
    expect(organization.members.map((m: { email: string; role: string; name: string | null }) => [m.email, m.role, m.name])).toEqual([
      ['owner@example.com', 'owner', 'Olive Owner'],
      ['admin@example.com', 'admin', 'Ada Admin'],
      ['member@example.com', 'member', null],
    ])
    expect(parse(files, `pages/${memberPage.slug}/page.json`).owner).toEqual({ name: null, email: 'member@example.com' })

    // Only while they still own it
    await db.update(schema.memberships).set({ role: 'admin' }).where(eq(schema.memberships.userId, owner.id))
    expect((await call(view.downloadUrl!, { cookie: owner.cookie })).status).toBe(404)
  })

  it('emails a link to the organization settings', async () => {
    const owner = await createUser({ email: 'boss@example.com' })
    const org = await createOrg(owner, 'Globex', 'globex')
    await exportOf(owner, { organizationId: org.id, versions: 'current' })
    expect(sendExportReady).toHaveBeenCalledWith('boss@example.com', {
      organization: 'Globex',
      link: `${env.appUrl}/organizations/globex/settings#export`,
      hours: EXPORT_HOURS,
    })
  })
})
