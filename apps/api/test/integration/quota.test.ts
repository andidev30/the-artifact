import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { call, callTool, connectAgent, createOrg, createPage, createUser, slugFrom, type TestUser } from './helpers.js'

// A self-hosted server with WORKSPACE_MAX_* set; unset, a workspace holds any number of pages
beforeEach(() => {
  env.selfHosted = true
})

afterEach(() => {
  env.selfHosted = false
  env.workspaceQuota = { pages: null, versions: null, bytes: null }
})

function republish(owner: TestUser, slug: string, html: string) {
  return publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 'test', title: 'Page', html, slug })
}

describe('workspace quotas on a self-hosted server', () => {
  it('are off unless set', async () => {
    const owner = await createUser()
    for (let i = 0; i < 5; i++) await createPage(owner, { html: `<p>${'x'.repeat(10_000)}${i}</p>` })
    expect(await db.select().from(schema.artifacts)).toHaveLength(5)
  })

  it('limit the pages of a workspace, with a message the agent can act on', async () => {
    env.workspaceQuota.pages = 2
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    await createPage(owner)
    const second = await callTool(token, 'publish_artifact', { title: 'Two', html: '<p>2</p>' })
    const res = await callTool(token, 'publish_artifact', { title: 'Three', html: '<p>3</p>' })
    expect(res).toEqual({
      isError: true,
      text: 'Your personal workspace has 2 pages, the most this server allows. Publish a new version of a page you have (pass its artifact_id), or delete one you no longer need in the gallery.',
    })
    expect((await callTool(token, 'publish_artifact', { title: 'Two', html: '<p>2b</p>', artifact_id: slugFrom(second.text) })).isError).toBe(false)
  })

  it('count an organization as one workspace, apart from its members’ personal ones', async () => {
    env.workspaceQuota.pages = 1
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await db.insert(schema.memberships).values({ organizationId: org.id, userId: member.id, role: 'member' })
    await createPage(owner, { organizationId: org.id })
    await expect(createPage(member, { organizationId: org.id })).rejects.toThrow(/^This organization has 1 page, the most this server allows\./)
    await createPage(member)
  })

  it('limit the versions of a workspace', async () => {
    env.workspaceQuota.versions = 2
    const owner = await createUser()
    const page = await createPage(owner)
    await republish(owner, page.slug, '<p>v2</p>')
    await expect(republish(owner, page.slug, '<p>v3</p>')).rejects.toThrow(
      /^Your personal workspace has 2 versions of its pages, the most this server allows\. Delete pages you no longer need/,
    )
    // Restoring adds a version too
    const res = await call(`/api/artifacts/${page.slug}/versions/1/restore`, { method: 'POST', cookie: owner.cookie })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/2 versions of its pages/)
    // A new page needs a version as well
    await expect(createPage(owner)).rejects.toThrow(/2 versions/)
  })

  it('limit storage: every version counts in full, files included', async () => {
    env.workspaceQuota.bytes = 3000
    const owner = await createUser()
    const token = (await connectAgent(owner)).access_token
    const html = `<p>${'a'.repeat(993)}</p>` // 1,000 bytes
    const first = await callTool(token, 'publish_artifact', { title: 'Big', html, files: [{ path: 'data.txt', content: 'b'.repeat(1000) }] })
    expect(first.isError).toBe(false)
    // Publishing the same content again stores nothing new, but is another 2,000 bytes of history
    const again = await callTool(token, 'publish_artifact', {
      title: 'Big',
      html,
      files: [{ path: 'data.txt', content: 'b'.repeat(1000) }],
      artifact_id: slugFrom(first.text),
    })
    expect(again).toEqual({
      isError: true,
      text: 'This would take your personal workspace past 2.9 KB of storage, the most this server allows (2 KB used, this version is 2 KB). Delete pages you no longer need in the gallery, or make the page smaller.',
    })
    expect((await callTool(token, 'publish_artifact', { title: 'Small', html: `<p>${'c'.repeat(993)}</p>` })).isError).toBe(false)
    expect((await callTool(token, 'publish_artifact', { title: 'Tiny', html: '<p>1</p>' })).isError).toBe(true)

    // Deleting a page frees its room
    const [big] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.title, 'Big'))
    expect((await call(`/api/artifacts/${big.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect((await callTool(token, 'publish_artifact', { title: 'Tiny', html: '<p>1</p>' })).isError).toBe(false)
  })

  it('let only one of two publishes at once take the last place', async () => {
    env.workspaceQuota.pages = 1
    const owner = await createUser()
    const results = await Promise.allSettled([createPage(owner, { title: 'A' }), createPage(owner, { title: 'B' })])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await db.select().from(schema.artifacts)).toHaveLength(1)
  })
})
