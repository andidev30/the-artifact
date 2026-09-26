import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { app } from '../../src/app.js'
import { db, schema } from '../../src/db/index.js'
import { sendShareNotice } from '../../src/mail.js'
import { call, callTool, connectAgent, createOrg, createUser, mcpRequest, slugFrom } from './helpers.js'

const HTML = '<!doctype html><title>Chart</title><h1>Signups by week</h1>'

async function setup() {
  const user = await createUser({ email: 'dev@example.com', name: 'Dev Person' })
  const { access_token } = await connectAgent(user)
  return { user, token: access_token }
}

describe('MCP over /mcp', () => {
  it('initializes', async () => {
    const { token } = await setup()
    const res = await mcpRequest(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.serverInfo).toMatchObject({ name: 'the-artifact' })
    expect(body.result.capabilities.tools).toBeDefined()
    // Stateless: no session id to carry
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })

  it('lists the tools', async () => {
    const { token } = await setup()
    const body = await (await mcpRequest(token, 'tools/list')).json()
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'get_artifact',
      'list_artifacts',
      'publish_artifact',
      'rename_artifact',
      'set_artifact_visibility',
      'share_artifact',
    ])
  })

  it('publishes, republishes to the same link, lists and reads pages', async () => {
    const { user, token } = await setup()

    const first = await callTool(token, 'publish_artifact', { title: 'Signups', html: HTML })
    expect(first.isError).toBe(false)
    const slug = slugFrom(first.text)
    expect(first.text).toContain('Published "Signups"')
    expect(first.text).toContain(`Link: http://localhost:5177/a/${slug}`)
    expect(first.text).toMatch(/restricted/)

    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
    expect(row).toMatchObject({ ownerId: user.id, organizationId: null, visibility: 'private', currentVersion: 1, publishedWith: 'claude-code' })

    // Passing the full link publishes a new version at the same address
    const second = await callTool(token, 'publish_artifact', {
      title: 'Signups v2',
      html: '<h1>v2</h1>',
      artifact_id: `http://localhost:5177/a/${slug}`,
    })
    expect(second.text).toContain('Published version 2 of "Signups v2"')
    expect(slugFrom(second.text)).toBe(slug)
    expect(await db.select().from(schema.artifacts)).toHaveLength(1)
    expect(await db.select().from(schema.artifactVersions)).toHaveLength(2)

    const list = await callTool(token, 'list_artifacts', {})
    expect(list.text).toContain(`Signups v2 (artifact_id: ${slug}, v2, restricted)`)

    const got = await callTool(token, 'get_artifact', { artifact_id: slug })
    expect(got.text).toBe('Title: Signups v2\nVersion: 2\n\n<h1>v2</h1>')

    const me = await (await call('/api/me', { cookie: user.cookie })).json()
    expect(me.hasPublished).toBe(true)
  })

  it('an empty workspace lists nothing', async () => {
    const { token } = await setup()
    expect((await callTool(token, 'list_artifacts', {})).text).toMatch(/No pages yet/)
  })

  it('publishes into the organization the token was granted for', async () => {
    const user = await createUser()
    const org = await createOrg(user, 'Acme', 'acme')
    const { access_token } = await connectAgent(user, org.id)
    const res = await callTool(access_token, 'publish_artifact', { title: 'Team page', html: HTML })
    expect(res.text).toMatch(/everyone in your organization/)
    const [row] = await db.select().from(schema.artifacts)
    expect(row).toMatchObject({ organizationId: org.id, visibility: 'organization' })
  })

  it('refuses organization visibility in a personal workspace', async () => {
    const { token } = await setup()
    const res = await callTool(token, 'publish_artifact', { title: 'X', html: HTML, visibility: 'organization' })
    expect(res.isError).toBe(true)
    expect(await db.select().from(schema.artifacts)).toHaveLength(0)
  })

  it('refuses pages over 2 MB', async () => {
    const { token } = await setup()
    const res = await callTool(token, 'publish_artifact', { title: 'Huge', html: 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/larger than 2 MB/)
  })

  it("can't republish, read, or change someone else's page", async () => {
    const { token } = await setup()
    const other = await createUser({ email: 'other@example.com' })
    const otherToken = (await connectAgent(other)).access_token
    const slug = slugFrom((await callTool(otherToken, 'publish_artifact', { title: 'Secret', html: HTML })).text)

    const republish = await callTool(token, 'publish_artifact', { title: 'Hijack', html: 'x', artifact_id: slug })
    expect(republish.isError).toBe(true)
    expect((await callTool(token, 'get_artifact', { artifact_id: slug })).isError).toBe(true)
    expect((await callTool(token, 'set_artifact_visibility', { artifact_id: slug, visibility: 'link' })).isError).toBe(true)
    expect((await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['dev@example.com'] })).isError).toBe(true)
    expect((await callTool(token, 'get_artifact', { artifact_id: 'doesnotexist' })).isError).toBe(true)

    const [row] = await db.select().from(schema.artifacts)
    expect(row).toMatchObject({ title: 'Secret', currentVersion: 1, visibility: 'private' })
  })

  it('changes visibility', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Page', html: HTML })).text)

    const res = await callTool(token, 'set_artifact_visibility', { artifact_id: slug, visibility: 'link' })
    expect(res.text).toMatch(/anyone who has the link/)
    expect((await call(`/api/artifacts/${slug}`)).status).toBe(200)

    const org = await callTool(token, 'set_artifact_visibility', { artifact_id: slug, visibility: 'organization' })
    expect(org.isError).toBe(true)
    expect(org.text).toMatch(/personal workspace/)

    await callTool(token, 'set_artifact_visibility', { artifact_id: slug, visibility: 'private' })
    expect((await call(`/api/artifacts/${slug}`)).status).toBe(404)
  })

  it('shares a page by email', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Report', html: HTML })).text)

    const res = await callTool(token, 'share_artifact', {
      artifact_id: slug,
      emails: ['Friend@Example.com', 'dev@example.com', 'second@example.com'],
      role: 'editor',
      message: 'Have a look',
    })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Shared "Report" with friend@example.com, second@example.com as editor.')
    expect(vi.mocked(sendShareNotice)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendShareNotice)).toHaveBeenCalledWith('friend@example.com', {
      from: 'Dev Person',
      title: 'Report',
      link: `http://localhost:5177/a/${slug}`,
      role: 'editor',
      message: 'Have a look',
    })

    // The person it was shared with can now open and edit it
    const friend = await createUser({ email: 'friend@example.com' })
    const page = await (await call(`/api/artifacts/${slug}`, { cookie: friend.cookie })).json()
    expect(page.canEdit).toBe(true)
  })

  it('reports share emails that could not be sent', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Report', html: HTML })).text)
    vi.mocked(sendShareNotice).mockRejectedValueOnce(new Error('SMTP down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['a@example.com'] })
    spy.mockRestore()
    expect(res.text).toMatch(/could not be sent to a@example.com/)
    expect(await db.select().from(schema.artifactShares)).toHaveLength(1)
  })

  it('reports invalid share input as a tool error', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Report', html: HTML })).text)
    expect((await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['nope'] })).text).toMatch(/don't look like email/)
    expect((await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['dev@example.com'] })).text).toMatch(/owner already has access/)
  })

  it('an editor it was shared with can publish a new version', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Report', html: HTML })).text)
    await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['editor@example.com'], role: 'editor' })
    await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['viewer@example.com'], role: 'viewer' })

    const editor = await createUser({ email: 'editor@example.com' })
    const viewer = await createUser({ email: 'viewer@example.com' })
    const editorToken = (await connectAgent(editor, null, 'cursor')).access_token
    const viewerToken = (await connectAgent(viewer)).access_token

    const res = await callTool(editorToken, 'publish_artifact', { title: 'Report', html: '<p>edited</p>', artifact_id: slug })
    expect(res.text).toContain('Published version 2')
    const [row] = await db.select().from(schema.artifacts)
    expect(row.publishedWith).toBe('cursor')
    expect(row.ownerId).not.toBe(editor.id)

    expect((await callTool(viewerToken, 'get_artifact', { artifact_id: slug })).text).toContain('<p>edited</p>')
    expect((await callTool(viewerToken, 'publish_artifact', { title: 'x', html: 'x', artifact_id: slug })).isError).toBe(true)
  })

  it('refuses organization visibility when republishing a personal page', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Page', html: HTML })).text)
    const res = await callTool(token, 'publish_artifact', { title: 'Page', html: HTML, artifact_id: slug, visibility: 'organization' })
    expect(res.isError).toBe(true)
    const [row] = await db.select().from(schema.artifacts)
    expect(row.visibility).toBe('private')
  })

  it('renames a page with the same rules as the web app', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Draft', html: HTML })).text)

    const res = await callTool(token, 'rename_artifact', { artifact_id: `http://localhost:5177/a/${slug}`, title: '  Q3 report  ' })
    expect(res.isError).toBe(false)
    expect(res.text).toContain('Renamed "Draft" to "Q3 report"')
    const [row] = await db.select().from(schema.artifacts)
    expect(row).toMatchObject({ title: 'Q3 report', currentVersion: 1 })

    const blank = await callTool(token, 'rename_artifact', { artifact_id: slug, title: '   ' })
    expect(blank).toMatchObject({ isError: true, text: 'Give the page a name.' })
    const long = await callTool(token, 'rename_artifact', { artifact_id: slug, title: 'x'.repeat(201) })
    expect(long).toMatchObject({ isError: true, text: 'Keep the name under 200 characters.' })
    expect((await callTool(token, 'rename_artifact', { artifact_id: slug, title: 'x'.repeat(200) })).isError).toBe(false)
  })

  it('only editors can rename', async () => {
    const { token } = await setup()
    const slug = slugFrom((await callTool(token, 'publish_artifact', { title: 'Report', html: HTML })).text)
    await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['editor@example.com'], role: 'editor' })
    await callTool(token, 'share_artifact', { artifact_id: slug, emails: ['viewer@example.com'], role: 'viewer' })
    const editorToken = (await connectAgent(await createUser({ email: 'editor@example.com' }))).access_token
    const viewerToken = (await connectAgent(await createUser({ email: 'viewer@example.com' }))).access_token
    const strangerToken = (await connectAgent(await createUser({ email: 'stranger@example.com' }))).access_token

    expect((await callTool(viewerToken, 'rename_artifact', { artifact_id: slug, title: 'Viewer' })).text).toContain('No page you can edit')
    expect((await callTool(strangerToken, 'rename_artifact', { artifact_id: slug, title: 'Stranger' })).isError).toBe(true)
    expect((await callTool(token, 'rename_artifact', { artifact_id: 'nope', title: 'X' })).isError).toBe(true)
    expect((await callTool(editorToken, 'rename_artifact', { artifact_id: slug, title: 'Edited' })).isError).toBe(false)
    const [row] = await db.select().from(schema.artifacts)
    expect(row.title).toBe('Edited')
  })
})

// The official client on the 2026-07-28 revision: per-request envelope, negotiated with server/discover
describe('MCP over /mcp for 2026-07-28 clients', () => {
  async function connect(token?: string) {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    })
    const client = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    await client.connect(transport)
    return client
  }

  it('negotiates the modern revision and serves the same tools', async () => {
    const { token } = await setup()
    const client = await connect(token)
    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect(client.getServerVersion()).toMatchObject({ name: 'the-artifact' })

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['get_artifact', 'list_artifacts', 'publish_artifact', 'rename_artifact', 'set_artifact_visibility', 'share_artifact'])
    expect(tools.find((t) => t.name === 'get_artifact')?.annotations).toEqual({ readOnlyHint: true })
    await client.close()
  })

  it('publishes and reads pages as the person behind the token', async () => {
    const { user, token } = await setup()
    const client = await connect(token)
    type Result = { content: { type: string; text: string }[]; isError?: boolean }
    const published = (await client.callTool({ name: 'publish_artifact', arguments: { title: 'Modern', html: HTML } })) as Result
    expect(published.isError).toBeFalsy()
    const slug = slugFrom(published.content[0].text)
    const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
    expect(row).toMatchObject({ ownerId: user.id, title: 'Modern' })

    const got = (await client.callTool({ name: 'get_artifact', arguments: { artifact_id: slug } })) as Result
    expect(got.content[0].text).toBe(`Title: Modern\nVersion: 1\n\n${HTML}`)
    const missing = (await client.callTool({ name: 'get_artifact', arguments: { artifact_id: 'nope' } })) as Result
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'No page you can open has the id "nope".' }] })
    await client.close()
  })

  it('asks for sign-in without a token', async () => {
    await expect(connect()).rejects.toThrow()
    const res = await call('/mcp', {
      headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
      json: { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/)
  })
})
