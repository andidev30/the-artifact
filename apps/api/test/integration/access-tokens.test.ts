import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { hashToken } from '../../src/auth/session.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { addMember, call, callTool, connectAgent, createOrg, createUser, mcpRequest, slugFrom, type TestUser } from './helpers.js'

const HTML = '<!doctype html><title>Report</title><h1>Tests passed</h1>'
const DAY = 24 * 60 * 60 * 1000

const original = { rateLimits: env.rateLimits }
afterEach(() => {
  env.rateLimits = original.rateLimits
})

type Created = { token: string; accessToken: { id: string; name: string; workspace: { id: string | null; name: string }; expiresAt: string | null } }

async function createToken(user: TestUser, body: Record<string, unknown> = {}) {
  const res = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI', organizationId: null, ...body } })
  expect(res.status).toBe(201)
  return (await res.json()) as Created
}

const publishJson = (token: string, body: Record<string, unknown>) => call('/api/publish', { bearer: token, json: body })

function publishForm(token: string | null, form: FormData) {
  return app.request('/api/publish', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form })
}

describe('creating access tokens', () => {
  it('shows the token once, with its prefix, and stores only its hash', async () => {
    const user = await createUser()
    const before = Date.now()
    const { token, accessToken } = await createToken(user, { name: '  Nightly   report ' })
    expect(token).toMatch(/^art_[A-Za-z0-9_-]{43}$/)
    expect(accessToken).toMatchObject({ name: 'Nightly report', workspace: { id: null, name: 'Personal' }, lastUsedAt: null, expired: false })
    // 90 days unless chosen otherwise
    const expires = new Date(accessToken.expiresAt!).getTime()
    expect(expires).toBeGreaterThanOrEqual(before + 90 * DAY - 1000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 90 * DAY + 1000)

    const [row] = await db.select().from(schema.accessTokens)
    expect(row.tokenHash).toBe(hashToken(token))
    expect(JSON.stringify(row)).not.toContain(token)

    const list = await call('/api/me/access-tokens', { cookie: user.cookie })
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(text).not.toContain(token)
    expect(text).not.toContain(row.tokenHash)
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ id: accessToken.id, name: 'Nightly report' })])
  })

  it('takes the offered expiries, or none', async () => {
    const user = await createUser()
    const week = await createToken(user, { expiresInDays: 7 })
    expect(new Date(week.accessToken.expiresAt!).getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY + 1000)
    const never = await createToken(user, { expiresInDays: null })
    expect(never.accessToken.expiresAt).toBeNull()

    const odd = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI', expiresInDays: 12 } })
    expect(odd.status).toBe(400)
    expect(await odd.json()).toMatchObject({ field: 'expiresInDays' })
  })

  it('needs a name', async () => {
    const user = await createUser()
    for (const name of ['', '   ', 'x'.repeat(61), 42]) {
      const res = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name } })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'name', error: 'Use 1 to 60 characters for the name.' })
    }
  })

  it('is only for workspaces the person is in', async () => {
    const owner = await createUser()
    const outsider = await createUser()
    const org = await createOrg(owner)
    for (const organizationId of [org.id, 'not-a-uuid', 7]) {
      const res = await call('/api/me/access-tokens', { cookie: outsider.cookie, json: { name: 'CI', organizationId } })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ field: 'organizationId' })
    }
    const { accessToken } = await createToken(owner, { organizationId: org.id })
    expect(accessToken.workspace).toEqual({ id: org.id, name: 'Acme Inc' })
  })

  it('is rate limited per account', async () => {
    env.rateLimits = 'access-token=2/1h'
    const user = await createUser()
    await createToken(user)
    await createToken(user)
    const res = await call('/api/me/access-tokens', { cookie: user.cookie, json: { name: 'CI' } })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await res.json()).error).toMatch(/^You have created a lot of access tokens in a short time\. Try again in/)
    // Someone else still can
    await createToken(await createUser())
  })

  it('needs a signed-in session, not a token', async () => {
    const user = await createUser()
    const { token } = await createToken(user)
    for (const [path, method] of [
      ['/api/me/access-tokens', 'GET'],
      ['/api/me/access-tokens', 'POST'],
      ['/api/me', 'GET'],
      ['/api/artifacts', 'GET'],
      ['/api/folders?workspace=personal', 'GET'],
    ]) {
      const res = await call(path, { method, bearer: token, ...(method === 'POST' ? { json: { name: 'Another' } } : {}) })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    expect(await db.$count(schema.accessTokens)).toBe(1)
  })
})

describe('GET /api/whoami', () => {
  it('says whom a token acts for, and in which workspace', async () => {
    const user = await createUser({ name: 'Ana' })
    const org = await createOrg(user)
    const personal = await createToken(user, { name: 'Laptop' })
    const res = await call('/api/whoami', { bearer: personal.token })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: user.email, name: 'Ana', workspace: { id: null, name: 'Personal' }, client: 'Laptop' })
    const team = await createToken(user, { name: 'CI', organizationId: org.id })
    expect((await (await call('/api/whoami', { bearer: team.token })).json()).workspace).toEqual({ id: org.id, name: 'Acme Inc' })
  })

  it('takes OAuth tokens too, and refuses anything else like POST /api/publish', async () => {
    const user = await createUser()
    const tokens = await connectAgent(user)
    expect((await (await call('/api/whoami', { bearer: tokens.access_token })).json()).client).toBe('claude-code')
    expect((await call('/api/whoami')).status).toBe(401)
    const bad = await call('/api/whoami', { bearer: 'art_nope' })
    expect(bad.status).toBe(401)
    expect((await bad.json()).error).toBe('This access token is not valid. It may have expired or been revoked.')
    expect((await call('/api/whoami', { cookie: user.cookie })).status).toBe(401)
  })
})

describe('publishing with an access token', () => {
  it('publishes over POST /api/publish as JSON, and new versions at the same link', async () => {
    const user = await createUser()
    const { token } = await createToken(user, { name: 'GitHub Actions' })
    const res = await publishJson(token, {
      title: 'Test report',
      html: '<!doctype html><link rel="stylesheet" href="style.css"><h1>Report</h1>',
      files: [{ path: 'style.css', content: 'h1 { color: green }' }],
      folder: 'CI',
    })
    expect(res.status).toBe(201)
    const page = (await res.json()) as { id: string; url: string; version: number; visibility: string; folder: string | null; title: string }
    expect(page).toMatchObject({ title: 'Test report', version: 1, visibility: 'private', folder: 'CI', url: `http://localhost:5177/a/${page.id}` })

    const [artifact] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, page.id))
    expect(artifact).toMatchObject({ ownerId: user.id, organizationId: null, publishedWith: 'GitHub Actions' })

    const again = await publishJson(token, { title: 'Test report', html: HTML, artifact_id: page.url, visibility: 'link' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ id: page.id, version: 2, visibility: 'link', folder: 'CI' })
  })

  it('publishes multipart form data, one file part per path', async () => {
    const user = await createUser()
    const { token } = await createToken(user)
    const form = new FormData()
    form.set('title', 'Coverage')
    form.set('index.html', new Blob(['<!doctype html><img src="img/badge.png"><script src="app.js"></script>'], { type: 'text/html' }), 'index.html')
    form.set('app.js', new Blob(['console.log(1)']), 'app.js')
    form.set('img/badge.png', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]), 'badge.png')
    const res = await publishForm(token, form)
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    const [artifact] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, id))
    const [version] = await db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, artifact.id))
    const files = await db.select().from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, version.id))
    expect(files.map((f) => [f.path, f.size]).sort()).toEqual([
      ['app.js', 14],
      ['img/badge.png', 4],
    ])

    const stray = new FormData()
    stray.set('title', 'Coverage')
    stray.set('index.html', HTML)
    stray.set('colour', 'blue')
    const bad = await publishForm(token, stray)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ field: 'colour' })
  })

  it('answers with messages people can act on', async () => {
    const user = await createUser()
    const { token } = await createToken(user)
    const cases: [Record<string, unknown>, number, RegExp][] = [
      [{ html: HTML }, 400, /title/],
      [{ title: 'x' }, 400, /html/],
      [{ title: 'x', html: HTML, visibility: 'public' }, 400, /visibility/],
      [{ title: 'x', html: HTML, visibility: 'organization' }, 400, /Organization visibility needs an organization workspace/],
      [{ title: 'x', html: HTML, files: [{ path: 'evil.exe', content: 'x' }] }, 400, /isn't a supported file type/],
      [{ title: 'x', html: HTML, artifact_id: 'nopenope' }, 400, /No page you can edit/],
    ]
    for (const [body, status, message] of cases) {
      const res = await publishJson(token, body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      expect((await res.json()).error).toMatch(message)
    }
    const text = await call('/api/publish', { bearer: token, headers: { 'content-type': 'text/plain' }, method: 'POST' })
    expect(text.status).toBe(415)
  })

  it('refuses requests without a working token', async () => {
    const none = await call('/api/publish', { json: { title: 'x', html: HTML } })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/)
    const wrong = await publishJson(`art_${'a'.repeat(43)}`, { title: 'x', html: HTML })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toMatch(/invalid_token/)
    expect((await wrong.json()).error).toBe('This access token is not valid. It may have expired or been revoked.')
    // A session cookie is not enough
    const user = await createUser()
    expect((await call('/api/publish', { cookie: user.cookie, json: { title: 'x', html: HTML } })).status).toBe(401)
  })

  it('counts toward the publish limit', async () => {
    env.rateLimits = 'publish=1/1h'
    const user = await createUser()
    const { token } = await createToken(user)
    expect((await publishJson(token, { title: 'One', html: HTML })).status).toBe(201)
    const res = await publishJson(token, { title: 'Two', html: HTML })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect((await res.json()).error).toMatch(/limit of 1 new pages and versions per hour/)
  })

  it('works on /mcp with every tool', async () => {
    const user = await createUser()
    const { token } = await createToken(user, { name: 'Nightly' })
    const tools = await (await mcpRequest(token, 'tools/list')).json()
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain('publish_artifact')
    const published = await callTool(token, 'publish_artifact', { title: 'Dashboard', html: HTML })
    expect(published.isError).toBe(false)
    const slug = slugFrom(published.text)
    const listed = await callTool(token, 'list_artifacts', {})
    expect(listed.text).toContain(slug)
    const [artifact] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
    expect(artifact.publishedWith).toBe('Nightly')
  })

  it('updates last used at most once a minute', async () => {
    const user = await createUser()
    const { token, accessToken } = await createToken(user)
    await publishJson(token, { title: 'One', html: HTML })
    const [first] = await db.select().from(schema.accessTokens)
    expect(first.lastUsedAt).not.toBeNull()
    await publishJson(token, { title: 'Two', html: HTML })
    const [second] = await db.select().from(schema.accessTokens)
    expect(second.lastUsedAt).toEqual(first.lastUsedAt)

    const old = new Date(Date.now() - 5 * 60 * 1000)
    await db.update(schema.accessTokens).set({ lastUsedAt: old })
    await publishJson(token, { title: 'Three', html: HTML })
    const [third] = await db.select().from(schema.accessTokens)
    expect(third.lastUsedAt!.getTime()).toBeGreaterThan(old.getTime())
    const list = (await (await call('/api/me/access-tokens', { cookie: user.cookie })).json()) as { id: string; lastUsedAt: string }[]
    expect(list[0]).toMatchObject({ id: accessToken.id })
    expect(new Date(list[0].lastUsedAt).getTime()).toBe(third.lastUsedAt!.getTime())
  })
})

describe('workspaces and losing access', () => {
  it('publishes to the workspace the token is for', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const orgToken = (await createToken(owner, { organizationId: org.id })).token
    const personalToken = (await createToken(owner)).token

    const inOrg = (await (await publishJson(orgToken, { title: 'Team', html: HTML })).json()) as { id: string; visibility: string }
    expect(inOrg.visibility).toBe('organization')
    const personal = (await (await publishJson(personalToken, { title: 'Mine', html: HTML })).json()) as { id: string }
    const rows = await db.select({ slug: schema.artifacts.slug, organizationId: schema.artifacts.organizationId }).from(schema.artifacts)
    expect(rows).toEqual(
      expect.arrayContaining([
        { slug: inOrg.id, organizationId: org.id },
        { slug: personal.id, organizationId: null },
      ]),
    )
    // Each lists only its own workspace
    expect((await callTool(orgToken, 'list_artifacts', {})).text).not.toContain(personal.id)
    expect((await callTool(personalToken, 'list_artifacts', {})).text).not.toContain(inOrg.id)
  })

  it('stops working as soon as it is revoked', async () => {
    const user = await createUser()
    const { token, accessToken } = await createToken(user)
    expect((await mcpRequest(token, 'tools/list')).status).toBe(200)

    const other = await createUser()
    expect((await call(`/api/me/access-tokens/${accessToken.id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404)

    const res = await call(`/api/me/access-tokens/${accessToken.id}`, { method: 'DELETE', cookie: user.cookie })
    expect(res.status).toBe(204)
    const mcp = await mcpRequest(token, 'tools/list')
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toMatch(/invalid_token/)
    expect((await publishJson(token, { title: 'x', html: HTML })).status).toBe(401)
    expect((await call(`/api/me/access-tokens/${accessToken.id}`, { method: 'DELETE', cookie: user.cookie })).status).toBe(404)
    expect(await (await call('/api/me/access-tokens', { cookie: user.cookie })).json()).toEqual([])
  })

  it('stops working once it expires', async () => {
    const user = await createUser()
    const { token } = await createToken(user, { expiresInDays: 7 })
    await db.update(schema.accessTokens).set({ expiresAt: new Date(Date.now() - 1000) })
    expect((await publishJson(token, { title: 'x', html: HTML })).status).toBe(401)
    const [listed] = (await (await call('/api/me/access-tokens', { cookie: user.cookie })).json()) as { expired: boolean }[]
    expect(listed.expired).toBe(true)
  })

  it('stops working for an organization the person is no longer in', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    const orgToken = (await createToken(member, { organizationId: org.id })).token
    const personalToken = (await createToken(member)).token
    expect((await publishJson(orgToken, { title: 'x', html: HTML })).status).toBe(201)

    // Checked when it is used, whichever way the membership ends
    await db.delete(schema.memberships).where(eq(schema.memberships.userId, member.id))
    expect((await publishJson(orgToken, { title: 'x', html: HTML })).status).toBe(401)
    expect((await publishJson(personalToken, { title: 'x', html: HTML })).status).toBe(201)

    // Removing someone also deletes their tokens for the organization
    await addMember(org.id, member, 'member')
    expect((await publishJson(orgToken, { title: 'x', html: HTML })).status).toBe(201)
    expect((await call(`/api/organizations/${org.id}/members/${member.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(200)
    const left = await db.select({ organizationId: schema.accessTokens.organizationId }).from(schema.accessTokens)
    expect(left).toEqual([{ organizationId: null }])
  })

  it('stops working when the account is suspended', async () => {
    const user = await createUser()
    const { token } = await createToken(user)
    await db.update(schema.users).set({ suspendedAt: new Date() }).where(eq(schema.users.id, user.id))
    expect((await publishJson(token, { title: 'x', html: HTML })).status).toBe(401)
    expect((await mcpRequest(token, 'tools/list')).status).toBe(401)

    // Suspending from the admin area deletes them too
    await db.update(schema.users).set({ suspendedAt: null }).where(eq(schema.users.id, user.id))
    const admin = await createUser({ admin: true })
    expect((await call(`/api/admin/users/${user.id}`, { method: 'PATCH', cookie: admin.cookie, json: { suspended: true } })).status).toBe(200)
    expect(await db.$count(schema.accessTokens)).toBe(0)
  })
})

describe('access tokens in organization settings', () => {
  it('lets owners and admins see and revoke every member’s tokens for the organization', async () => {
    const owner = await createUser({ name: 'Olive' })
    const admin = await createUser()
    const member = await createUser({ name: 'Mel' })
    const org = await createOrg(owner)
    await addMember(org.id, admin, 'admin')
    await addMember(org.id, member, 'member')
    const memberOrg = await createToken(member, { name: 'Member CI', organizationId: org.id })
    const ownerOrg = await createToken(owner, { name: 'Owner CI', organizationId: org.id })
    await createToken(member, { name: 'Personal CI' })

    const res = await call(`/api/organizations/${org.id}/access-tokens`, { cookie: admin.cookie })
    expect(res.status).toBe(200)
    const listed = (await res.json()) as { id: string; name: string; owner: { id: string; name: string | null; email: string } }[]
    expect(listed.map((t) => t.name).sort()).toEqual(['Member CI', 'Owner CI'])
    expect(listed.find((t) => t.name === 'Member CI')?.owner).toEqual({ id: member.id, name: 'Mel', email: member.email })
    expect(JSON.stringify(listed)).not.toContain(memberOrg.token)

    // Members see their own in account settings, not everyone's
    const asMember = await call(`/api/organizations/${org.id}/access-tokens`, { cookie: member.cookie })
    expect(asMember.status).toBe(403)
    expect((await call(`/api/organizations/${org.id}/access-tokens/${ownerOrg.accessToken.id}`, { method: 'DELETE', cookie: member.cookie })).status).toBe(403)

    // Outsiders can't tell the organization exists
    const outsider = await createUser()
    expect((await call(`/api/organizations/${org.id}/access-tokens`, { cookie: outsider.cookie })).status).toBe(404)

    const revoked = await call(`/api/organizations/${org.id}/access-tokens/${memberOrg.accessToken.id}`, { method: 'DELETE', cookie: admin.cookie })
    expect(revoked.status).toBe(204)
    expect((await publishJson(memberOrg.token, { title: 'x', html: HTML })).status).toBe(401)

    // Personal tokens are out of the organization's reach
    const [personal] = await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.name, 'Personal CI'))
    expect((await call(`/api/organizations/${org.id}/access-tokens/${personal.id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(404)
  })
})
