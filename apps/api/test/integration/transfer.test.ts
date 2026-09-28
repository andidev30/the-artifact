import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { auditSettled } from '../../src/audit.js'
import { db, schema } from '../../src/db/index.js'
import { pruneRetention } from '../../src/ee/retention.js'
import { env } from '../../src/env.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, flushViews, slugFrom, type TestUser } from './helpers.js'
import { enableEnterprise, removeTestSigningKeys } from './enterprise.js'

afterEach(async () => {
  await auditSettled()
  env.selfHosted = false
  env.workspaceQuota = { pages: null, versions: null, bytes: null }
  removeTestSigningKeys()
})

const duplicate = (user: TestUser, slug: string, json: unknown) => call(`/api/artifacts/${slug}/duplicate`, { cookie: user.cookie, json })
const move = (user: TestUser, slug: string, json: unknown) => call(`/api/artifacts/${slug}/move`, { cookie: user.cookie, json })

async function page(slug: string) {
  const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.slug, slug))
  return row
}

async function versionsOf(id: string) {
  return db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, id)).orderBy(schema.artifactVersions.version)
}

async function withFiles(owner: TestUser, organizationId: string | null = null) {
  return publish({
    userId: owner.id,
    email: owner.email,
    organizationId,
    clientName: 'test-client',
    title: 'Plan',
    html: '<!doctype html><link rel="stylesheet" href="style.css"><h1>v1</h1>',
    files: [{ path: 'style.css', content: 'h1 { color: red }' }],
    visibility: organizationId ? 'organization' : 'link',
  })
}

describe('duplicating a page', () => {
  it('copies the current version only, sharing its blobs, into a restricted page of your own', async () => {
    const owner = await createUser()
    const source = await withFiles(owner)
    await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: null,
      clientName: 'test-client',
      title: 'Plan',
      html: '<!doctype html><link rel="stylesheet" href="style.css"><h1>v2</h1>',
      files: [{ path: 'style.css', content: 'h1 { color: blue }' }],
      slug: source.slug,
    })
    await call(`/api/artifacts/${source.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: ['friend@example.com'], notify: false } })
    await call(`/api/artifacts/${source.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { linkPassword: 'a long password' } })
    await call(`/api/artifacts/${source.slug}/comments`, { cookie: owner.cookie, json: { body: 'Looks good' } })

    const res = await duplicate(owner, source.slug, { workspace: 'personal' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ title: 'Plan (copy)', visibility: 'private', workspace: 'personal' })
    expect(body.slug).not.toBe(source.slug)

    const copy = await page(body.slug)
    expect(copy).toMatchObject({ ownerId: owner.id, organizationId: null, visibility: 'private', currentVersion: 1, folderId: null })
    expect(copy.linkPasswordHash).toBeNull()
    expect(copy.linkToken).toBeNull()
    const [sourceV1, sourceV2] = await versionsOf(source.id)
    const copied = await versionsOf(copy.id)
    expect(copied).toHaveLength(1)
    expect(copied[0].htmlSha256).toBe(sourceV2.htmlSha256)
    expect(copied[0].htmlSha256).not.toBe(sourceV1.htmlSha256)
    const [sourceFile] = await db.select().from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, sourceV2.id))
    const [copyFile] = await db.select().from(schema.artifactFiles).where(eq(schema.artifactFiles.versionId, copied[0].id))
    expect(copyFile).toMatchObject({ path: 'style.css', sha256: sourceFile.sha256, size: sourceFile.size })

    expect(await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, copy.id))).toEqual([])
    expect(await db.select().from(schema.artifactComments).where(eq(schema.artifactComments.artifactId, copy.id))).toEqual([])

    // Served on its own, and still after the source is gone
    expect((await call(`/api/artifacts/${source.slug}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(204)
    expect(await (await call(`/api/artifacts/${copy.slug}/v/1/`, { cookie: owner.cookie })).text()).toContain('<h1>v2</h1>')
    expect(await (await call(`/api/artifacts/${copy.slug}/v/1/style.css`, { cookie: owner.cookie })).text()).toBe('h1 { color: blue }')
    await flushViews()
    const views = await (await call(`/api/artifacts/${copy.slug}/views`, { cookie: owner.cookie })).json()
    expect(views.total).toBe(0)
  })

  it('takes a title, and needs view access to the source and publish rights in the target', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, viewer, 'member')
    const other = await createOrg(stranger, 'Other Co', 'other')
    const source = await createPage(owner, { organizationId: org.id, visibility: 'organization', title: 'Roadmap' })
    const restricted = await createPage(owner, { organizationId: org.id, visibility: 'private' })

    const named = await duplicate(viewer, source.slug, { workspace: org.id, title: '  Roadmap v2  ' })
    expect(named.status).toBe(201)
    expect(await named.json()).toMatchObject({ title: 'Roadmap v2', workspace: org.id, visibility: 'private' })
    expect((await page((await (await duplicate(viewer, source.slug, { workspace: 'personal' })).json()).slug)).ownerId).toBe(viewer.id)

    expect((await duplicate(viewer, restricted.slug, { workspace: 'personal' })).status).toBe(404)
    expect((await duplicate(stranger, source.slug, { workspace: 'personal' })).status).toBe(404)
    const outside = await duplicate(viewer, source.slug, { workspace: other.id })
    expect(outside.status).toBe(404)
    expect(await outside.json()).toMatchObject({ field: 'workspace' })
    const unnamed = await duplicate(viewer, source.slug, { workspace: 'nope' })
    expect(unnamed.status).toBe(400)
    expect(await unnamed.json()).toEqual({ error: 'Choose a workspace: personal or one of your organizations.', field: 'workspace' })
    expect((await duplicate(viewer, source.slug, { workspace: org.id, title: '' })).status).toBe(400)
    expect((await call(`/api/artifacts/${source.slug}/duplicate`, { json: { workspace: 'personal' } })).status).toBe(401)
  })

  it('opens to people who have the link, and never copies the link itself', async () => {
    const owner = await createUser()
    const visitor = await createUser()
    const source = await createPage(owner, { visibility: 'link' })
    const res = await duplicate(visitor, source.slug, { workspace: 'personal' })
    expect(res.status).toBe(201)
    const copy = await page((await res.json()).slug)
    expect(copy.visibility).toBe('private')
    expect((await call(`/api/artifacts/${copy.slug}`)).status).toBe(404)
  })

  it('counts toward the quota of the target workspace', async () => {
    env.selfHosted = true
    env.workspaceQuota.pages = 1
    const owner = await createUser()
    const source = await createPage(owner)
    const res = await duplicate(owner, source.slug, { workspace: 'personal' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('Your personal workspace has 1 page')
    expect(await db.select().from(schema.artifacts)).toHaveLength(1)
  })

  it('keeps organizations that require two-factor sign-in closed to people without it', async () => {
    const owner = await createUser()
    const member = await createUser()
    const org = await createOrg(owner)
    await addMember(org.id, member, 'member')
    await db.update(schema.organizations).set({ requireTwoFactor: true }).where(eq(schema.organizations.id, org.id))
    const source = await createPage(member)
    const res = await duplicate(member, source.slug, { workspace: org.id })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'two_factor_required', error: expect.stringContaining('Acme Inc requires two-factor sign-in') })
    const moved = await move(member, source.slug, { workspace: org.id })
    expect(moved.status).toBe(403)
  })

  it('works over MCP, into the connected workspace or another one', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const token = (await connectAgent(owner)).access_token
    const source = await createPage(owner, { title: 'Notes' })

    const here = await callTool(token, 'duplicate_artifact', { artifact_id: source.slug })
    expect(here.isError).toBe(false)
    expect(here.text).toContain('Duplicated "Notes" as "Notes (copy)" in your personal workspace.')
    expect(here.text).toContain('restricted')
    const copy = await page(slugFrom(here.text))
    expect(copy).toMatchObject({ organizationId: null, publishedWith: 'claude-code' })

    const there = await callTool(token, 'duplicate_artifact', { artifact_id: source.slug, workspace: org.id, title: 'Team notes' })
    expect(there.text).toContain('as "Team notes" in Acme Inc.')
    expect((await page(slugFrom(there.text))).organizationId).toBe(org.id)

    const wrong = await callTool(token, 'duplicate_artifact', { artifact_id: source.slug, workspace: '00000000-0000-4000-8000-000000000000' })
    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain(`- ${org.id} (Acme Inc)`)
    expect((await callTool(token, 'duplicate_artifact', { artifact_id: 'nope' })).isError).toBe(true)
  })
})

describe('moving a page to another workspace', () => {
  it('moves a personal page into an organization, keeping its link, people, link settings, comments and versions', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const source = await withFiles(owner)
    await call(`/api/artifacts/${source.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: ['friend@example.com'], notify: false } })
    await call(`/api/artifacts/${source.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { linkPassword: 'a long password' } })
    await call(`/api/artifacts/${source.slug}/comments`, { cookie: owner.cookie, json: { body: 'Keep this' } })
    const folder = await (await call('/api/folders', { cookie: owner.cookie, json: { workspace: 'personal', name: 'Mine' } })).json()
    await call(`/api/artifacts/${source.slug}`, { method: 'PATCH', cookie: owner.cookie, json: { folder: folder.id } })

    const res = await move(owner, source.slug, { workspace: org.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slug: source.slug, visibility: 'link', workspace: org.id })
    const moved = await page(source.slug)
    expect(moved).toMatchObject({ id: source.id, organizationId: org.id, ownerId: owner.id, folderId: null, visibility: 'link' })
    expect(moved.linkPasswordHash).not.toBeNull()
    expect(await db.select().from(schema.artifactShares).where(eq(schema.artifactShares.artifactId, source.id))).toHaveLength(1)
    expect(await db.select().from(schema.artifactComments).where(eq(schema.artifactComments.artifactId, source.id))).toHaveLength(1)
    expect(await versionsOf(source.id)).toHaveLength(1)

    const list = await (await call(`/api/artifacts?workspace=${org.id}`, { cookie: owner.cookie })).json()
    expect(list.map((a: { slug: string }) => a.slug)).toEqual([source.slug])
    expect(await (await call('/api/artifacts?workspace=personal', { cookie: owner.cookie })).json()).toEqual([])
    const details = await (await call(`/api/artifacts/${source.slug}`, { cookie: owner.cookie })).json()
    expect(details).toMatchObject({ inOrganization: true, canMove: true, workspace: org.id })

    const already = await move(owner, source.slug, { workspace: org.id })
    expect(already.status).toBe(400)
    expect(await already.json()).toEqual({ error: 'The page is already in that workspace.', field: 'workspace' })
  })

  it('makes an organization page restricted when it moves to Personal, and records both sides', async () => {
    env.selfHosted = true
    await enableEnterprise()
    const owner = await createUser()
    const org = await createOrg(owner)
    const other = await createOrg(owner, 'Other Co', 'other')
    const source = await createPage(owner, { organizationId: org.id, visibility: 'organization' })

    const across = await move(owner, source.slug, { workspace: other.id })
    expect(await across.json()).toMatchObject({ visibility: 'organization', workspace: other.id })
    const home = await move(owner, source.slug, { workspace: 'personal' })
    expect(await home.json()).toMatchObject({ visibility: 'private', workspace: 'personal' })

    await auditSettled()
    const events = await db.select().from(schema.auditEvents)
    const moves = events
      .filter((e) => e.action.startsWith('page.moved'))
      .map((e) => ({ action: e.action, organizationId: e.organizationId, details: e.details, target: e.targetId }))
    expect(moves).toHaveLength(3)
    expect(moves).toEqual(
      expect.arrayContaining([
        { action: 'page.moved_out', organizationId: org.id, details: { to: 'Other Co' }, target: source.slug },
        { action: 'page.moved_in', organizationId: other.id, details: { from: 'Acme Inc' }, target: source.slug },
        { action: 'page.moved_out', organizationId: other.id, details: { to: null, visibility: { from: 'organization', to: 'private' } }, target: source.slug },
      ]),
    )
    const log = await (await call(`/api/organizations/${other.id}/audit-log?action=page.moved_in`, { cookie: owner.cookie })).json()
    expect(log.events).toHaveLength(1)
  })

  it('needs edit access, a place in the workspace the page is in, and publish rights in the target', async () => {
    const owner = await createUser()
    const admin = await createUser()
    const member = await createUser()
    const guestEditor = await createUser()
    const org = await createOrg(owner)
    const other = await createOrg(admin, 'Other Co', 'other')
    await addMember(org.id, admin, 'admin')
    await addMember(org.id, member, 'member')
    await addMember(other.id, guestEditor, 'member')
    const orgPage = await createPage(owner, { organizationId: org.id, visibility: 'organization' })
    const personal = await createPage(owner)
    await call(`/api/artifacts/${orgPage.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: [guestEditor.email], role: 'editor', notify: false } })
    await call(`/api/artifacts/${personal.slug}/sharing/people`, { cookie: owner.cookie, json: { emails: [admin.email], role: 'editor', notify: false } })

    // Viewers can't move; missing and no-access look the same
    expect((await move(member, orgPage.slug, { workspace: 'personal' })).status).toBe(404)
    // Someone it is only shared with can't carry it off
    expect((await move(guestEditor, orgPage.slug, { workspace: other.id })).status).toBe(404)
    // A personal page is its owner's to move, even for an editor
    expect((await move(admin, personal.slug, { workspace: org.id })).status).toBe(404)
    // Personal is the owner's
    const notYours = await move(admin, orgPage.slug, { workspace: 'personal' })
    expect(notYours.status).toBe(403)
    expect(await notYours.json()).toMatchObject({ field: 'workspace' })
    // An organization the mover isn't in
    expect((await move(owner, orgPage.slug, { workspace: other.id })).status).toBe(404)
    const bad = await move(owner, orgPage.slug, { workspace: 'bad' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ field: 'workspace' })
    expect((await page(orgPage.slug)).organizationId).toBe(org.id)

    // An admin of both moves it; the owner stays the owner
    expect((await move(admin, orgPage.slug, { workspace: other.id })).status).toBe(200)
    expect(await page(orgPage.slug)).toMatchObject({ organizationId: other.id, ownerId: owner.id })
    expect((await call(`/api/artifacts/${orgPage.slug}`, { cookie: member.cookie })).status).toBe(404)
    expect((await call(`/api/artifacts/${orgPage.slug}`, { cookie: guestEditor.cookie })).status).toBe(200)
  })

  it('brings every version into the quota of the target', async () => {
    env.selfHosted = true
    const owner = await createUser()
    const org = await createOrg(owner)
    const source = await createPage(owner, { organizationId: org.id })
    await publish({ userId: owner.id, email: owner.email, organizationId: org.id, clientName: 't', title: 'Page', html: '<p>2</p>', slug: source.slug })
    await createPage(owner)
    env.workspaceQuota.versions = 2
    const res = await move(owner, source.slug, { workspace: 'personal' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('versions')
    env.workspaceQuota.versions = 3
    expect((await move(owner, source.slug, { workspace: 'personal' })).status).toBe(200)
  })

  it('applies the Personal plan when moving into Personal on the hosted service', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const source = await createPage(owner, { organizationId: org.id })
    await db
      .insert(schema.artifacts)
      .values(Array.from({ length: 50 }, (_, i) => ({ slug: `filler${i}abcdef`.slice(0, 16), title: 'Filler', ownerId: owner.id, organizationId: null })))
    const res = await move(owner, source.slug, { workspace: 'personal' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('the free Personal plan')
  })

  it("applies the organization's retention once moved in", async () => {
    env.selfHosted = true
    await enableEnterprise()
    const owner = await createUser()
    const org = await createOrg(owner)
    const source = await createPage(owner)
    for (const n of [2, 3]) {
      await publish({ userId: owner.id, email: owner.email, organizationId: null, clientName: 't', title: 'Page', html: `<p>${n}</p>`, slug: source.slug })
    }
    await call(`/api/organizations/${org.id}/retention`, { method: 'PUT', cookie: owner.cookie, json: { keepVersions: 1 } })
    await pruneRetention()
    expect(await versionsOf(source.id)).toHaveLength(3)
    await move(owner, source.slug, { workspace: org.id })
    await pruneRetention()
    expect((await versionsOf(source.id)).map((v) => v.version)).toEqual([3])
  })

  it('works over MCP, keeping move_artifact for folders', async () => {
    const owner = await createUser()
    const org = await createOrg(owner)
    const token = (await connectAgent(owner)).access_token
    const source = await createPage(owner, { title: 'Draft' })

    const moved = await callTool(token, 'move_artifact', { artifact_id: source.slug, workspace: org.id, folder: 'Plans' })
    expect(moved.isError).toBe(false)
    expect(moved.text).toContain('Moved "Draft" to Acme Inc.')
    expect(moved.text).toContain('Moved "Draft" to the folder "Plans".')
    const [folder] = await db.select().from(schema.folders).where(eq(schema.folders.organizationId, org.id))
    expect(await page(source.slug)).toMatchObject({ organizationId: org.id, folderId: folder.id })

    // The page is now the organization's: the personal agent no longer acts on it, even for its owner
    expect((await callTool(token, 'move_artifact', { artifact_id: source.slug, folder: 'Mine' })).isError).toBe(true)
    expect((await callTool(token, 'move_artifact', { artifact_id: source.slug, workspace: 'personal' })).text).toContain('No page you can edit')

    const orgToken = (await connectAgent(owner, org.id)).access_token
    expect((await callTool(orgToken, 'move_artifact', { artifact_id: source.slug, workspace: org.id })).text).toContain('already in that workspace')
    expect((await callTool(orgToken, 'move_artifact', { artifact_id: source.slug })).isError).toBe(true)

    const back = await callTool(orgToken, 'move_artifact', { artifact_id: source.slug, workspace: 'personal' })
    expect(back.text).toContain('Moved "Draft" to your personal workspace.')
    expect(await page(source.slug)).toMatchObject({ organizationId: null, folderId: null })

    const stranger = await createUser()
    await createOrg(stranger, 'Other Co', 'other')
    const [otherOrg] = await db.select().from(schema.organizations).where(eq(schema.organizations.slug, 'other'))
    const refused = await callTool(token, 'move_artifact', { artifact_id: source.slug, workspace: otherOrg.id })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('- personal (your personal workspace)')
    expect(refused.text).not.toContain('Other Co')
  })
})
