import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import type { ShareRole, Visibility } from '../../src/db/schema.js'
import { env } from '../../src/env.js'
import { sendCommentNotice } from '../../src/mail.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, type TestUser } from './helpers.js'

const notice = vi.mocked(sendCommentNotice)
const original = { host: env.smtp.host, rateLimits: env.rateLimits }

afterEach(() => {
  env.smtp.host = original.host
  env.rateLimits = original.rateLimits
})

type Comment = {
  id: string
  body: string
  version: number
  author: string | null
  mine: boolean
  postedWith: string | null
  canEdit: boolean
  canDelete: boolean
}
type Thread = Comment & { resolved: { at: string; by: string | null } | null; canResolve: boolean; replies: Comment[] }
type Listing = { threads: Thread[]; next: string | null; seenAt: string | null; currentVersion: number }

const base = (slug: string) => `/api/artifacts/${slug}/comments`

function post(slug: string, user: TestUser | null, json: Record<string, unknown>) {
  return call(base(slug), { cookie: user?.cookie, json })
}

async function comment(slug: string, user: TestUser, body: string, replyTo?: string): Promise<Comment> {
  const res = await post(slug, user, { body, replyTo })
  expect(res.status).toBe(201)
  return res.json()
}

async function list(slug: string, user: TestUser): Promise<Listing> {
  const res = await call(base(slug), { cookie: user.cookie })
  expect(res.status).toBe(200)
  return res.json()
}

async function share(page: { id: string }, user: TestUser, role: ShareRole) {
  await db.insert(schema.artifactShares).values({ artifactId: page.id, email: user.email, role })
}

// An organization page and everyone who might open it
async function people(visibility: Visibility = 'organization') {
  const owner = await createUser({ email: 'owner@example.com', name: 'Olivia Owner' })
  const org = await createOrg(owner)
  const admin = await createUser({ name: 'Adam Admin' })
  const member = await createUser({ name: 'Mia Member' })
  const viewer = await createUser({ name: 'Vic Viewer' })
  const editor = await createUser({ name: 'Eve Editor' })
  const outsider = await createUser({ name: 'Otto Outsider' })
  await addMember(org.id, admin, 'admin')
  await addMember(org.id, member, 'member')
  const page = await createPage(owner, { organizationId: org.id, visibility, title: 'Launch plan' })
  await share(page, viewer, 'viewer')
  await share(page, editor, 'editor')
  return { owner, org, admin, member, viewer, editor, outsider, page }
}

describe('who can read and write comments', () => {
  it('follows who can open the page, and needs an account', async () => {
    const p = await people('organization')
    for (const who of [p.owner, p.admin, p.member, p.viewer, p.editor]) {
      expect((await call(base(p.page.slug), { cookie: who.cookie })).status).toBe(200)
      expect((await post(p.page.slug, who, { body: `From ${who.name}` })).status).toBe(201)
    }
    expect((await call(base(p.page.slug), { cookie: p.outsider.cookie })).status).toBe(404)
    expect((await post(p.page.slug, p.outsider, { body: 'Hi' })).status).toBe(404)
    expect((await call(base(p.page.slug))).status).toBe(401)
    expect((await post(p.page.slug, null, { body: 'Hi' })).status).toBe(401)
    expect((await call(base('nosuchpage'), { cookie: p.owner.cookie })).status).toBe(404)
  })

  it('keeps restricted pages to the people on them', async () => {
    const p = await people('private')
    expect((await call(base(p.page.slug), { cookie: p.member.cookie })).status).toBe(404)
    expect((await call(base(p.page.slug), { cookie: p.viewer.cookie })).status).toBe(200)
    expect((await call(base(p.page.slug), { cookie: p.admin.cookie })).status).toBe(200)
  })

  it('lets signed-in people with the link comment, but not signed-out visitors read', async () => {
    const p = await people('link')
    await comment(p.page.slug, p.outsider, 'Seen from outside')
    expect((await call(base(p.page.slug))).status).toBe(401)
    const page = await (await call(`/api/artifacts/${p.page.slug}`)).json()
    expect(page.comments).toBeNull()
    const signedIn = await (await call(`/api/artifacts/${p.page.slug}`, { cookie: p.owner.cookie })).json()
    expect(signedIn.comments).toEqual({ total: 1, unread: 1 })
  })
})

describe('threads', () => {
  it('records the version, keeps threads one level deep and orders them oldest first', async () => {
    const p = await people()
    const first = await comment(p.page.slug, p.member, 'The chart is cut off')
    expect(first).toMatchObject({ version: 1, author: 'Mia Member', mine: true, canEdit: true, canDelete: true, postedWith: null })

    await publish({
      userId: p.owner.id,
      email: p.owner.email,
      organizationId: p.org.id,
      clientName: 'claude-code',
      title: 'Launch plan',
      html: '<p>v2',
      slug: p.page.slug,
    })
    const reply = await comment(p.page.slug, p.owner, 'Fixed in version 2', first.id)
    await comment(p.page.slug, p.member, 'Thanks', reply.id)
    const second = await comment(p.page.slug, p.viewer, 'Another thing')

    const { threads, currentVersion } = await list(p.page.slug, p.viewer)
    expect(currentVersion).toBe(2)
    expect(threads.map((t) => t.id)).toEqual([first.id, second.id])
    expect(threads[0].replies.map((r) => [r.body, r.version, r.author])).toEqual([
      ['Fixed in version 2', 2, 'Olivia Owner'],
      ['Thanks', 2, 'Mia Member'],
    ])
    expect(threads[0]).toMatchObject({ mine: false, canEdit: false, canDelete: false, canResolve: false })
  })

  it('checks the text', async () => {
    const p = await people()
    const empty = await post(p.page.slug, p.member, { body: '   ' })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ field: 'body' })
    expect((await post(p.page.slug, p.member, { body: 'x'.repeat(5001) })).status).toBe(400)
    expect((await post(p.page.slug, p.member, { body: 'x'.repeat(5000) })).status).toBe(201)
    // Stored and returned as written; the app shows it as text
    const html = await comment(p.page.slug, p.member, '<img src=x onerror=alert(1)>')
    expect(html.body).toBe('<img src=x onerror=alert(1)>')
  })

  it("won't reply to a comment of another page", async () => {
    const p = await people()
    const other = await createPage(p.owner, { organizationId: p.org.id, visibility: 'organization' })
    const elsewhere = await comment(other.slug, p.member, 'On the other page')
    expect((await post(p.page.slug, p.member, { body: 'Reply', replyTo: elsewhere.id })).status).toBe(404)
    expect((await post(p.page.slug, p.member, { body: 'Reply', replyTo: 'not-an-id' })).status).toBe(404)
    expect((await call(`${base(p.page.slug)}/${elsewhere.id}`, { method: 'DELETE', cookie: p.owner.cookie })).status).toBe(404)
  })

  it('lets authors edit their own comments only', async () => {
    const p = await people()
    const c = await comment(p.page.slug, p.member, 'Typo hre')
    const edited = await call(`${base(p.page.slug)}/${c.id}`, { method: 'PATCH', cookie: p.member.cookie, json: { body: 'Typo here' } })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ body: 'Typo here' })
    const [row] = await db.select().from(schema.artifactComments).where(eq(schema.artifactComments.id, c.id))
    expect(row.editedAt).not.toBeNull()

    // Not even the owner rewrites someone else's words
    const other = await call(`${base(p.page.slug)}/${c.id}`, { method: 'PATCH', cookie: p.owner.cookie, json: { body: 'Changed' } })
    expect(other.status).toBe(403)
    const empty = await call(`${base(p.page.slug)}/${c.id}`, { method: 'PATCH', cookie: p.member.cookie, json: { body: '' } })
    expect(empty.status).toBe(400)
  })

  it('lets authors delete their comments and editors delete any', async () => {
    const p = await people()
    const mine = await comment(p.page.slug, p.member, 'Mine')
    const theirs = await comment(p.page.slug, p.viewer, 'Theirs')
    const reply = await comment(p.page.slug, p.member, 'A reply', theirs.id)

    const del = (id: string, user: TestUser) => call(`${base(p.page.slug)}/${id}`, { method: 'DELETE', cookie: user.cookie })
    expect((await del(theirs.id, p.member)).status).toBe(403)
    expect((await del(mine.id, p.member)).status).toBe(204)
    expect((await del(mine.id, p.member)).status).toBe(404)

    // Moderation: the owner, an editor it is shared with and organization admins can delete any comment
    const again = await comment(p.page.slug, p.member, 'Again')
    expect((await del(again.id, p.editor)).status).toBe(204)
    expect((await del(reply.id, p.admin)).status).toBe(204)
    const threads = (await list(p.page.slug, p.owner)).threads
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ canDelete: true, canResolve: true })

    // The first comment of a thread takes its replies with it
    await comment(p.page.slug, p.member, 'Reply', theirs.id)
    expect((await del(theirs.id, p.owner)).status).toBe(204)
    expect(await db.select().from(schema.artifactComments)).toHaveLength(0)
  })

  it('resolves threads for their author and editors, and a reply reopens them', async () => {
    const p = await people()
    const t = await comment(p.page.slug, p.member, 'Please fix the header')
    const reply = await comment(p.page.slug, p.viewer, 'Agreed', t.id)
    const resolve = (id: string, user: TestUser, resolved: boolean) =>
      call(`${base(p.page.slug)}/${id}`, { method: 'PATCH', cookie: user.cookie, json: { resolved } })

    expect((await resolve(t.id, p.viewer, true)).status).toBe(403)
    const done = await resolve(t.id, p.member, true)
    expect(done.status).toBe(200)
    expect((await done.json()).resolved).toMatchObject({ by: 'Mia Member' })
    expect((await resolve(t.id, p.member, false)).status).toBe(200)
    // A reply's id resolves its thread
    expect((await resolve(reply.id, p.editor, true)).status).toBe(200)
    expect((await list(p.page.slug, p.owner)).threads[0].resolved).toMatchObject({ by: 'Eve Editor' })

    await comment(p.page.slug, p.viewer, 'Still broken on mobile', t.id)
    expect((await list(p.page.slug, p.owner)).threads[0].resolved).toBeNull()
  })

  it('go with the page', async () => {
    const p = await people()
    await comment(p.page.slug, p.member, 'Hello')
    expect((await call(`/api/artifacts/${p.page.slug}`, { method: 'DELETE', cookie: p.owner.cookie })).status).toBe(204)
    expect(await db.select().from(schema.artifactComments)).toHaveLength(0)
    expect(await db.select().from(schema.commentReads)).toHaveLength(0)
  })

  it('stay when their author deletes their account', async () => {
    const p = await people()
    const t = await comment(p.page.slug, p.member, 'Keep this')
    await comment(p.page.slug, p.viewer, 'A reply', t.id)
    const res = await call('/api/me', { method: 'DELETE', cookie: p.member.cookie, json: { confirmEmail: p.member.email } })
    expect(res.status).toBe(204)
    const { threads } = await list(p.page.slug, p.owner)
    expect(threads[0]).toMatchObject({ body: 'Keep this', author: null })
    expect(threads[0].replies).toHaveLength(1)
  })
})

describe('emails about comments', () => {
  it("emails the owner, and a thread's author about replies, never people about their own", async () => {
    const p = await people()
    await comment(p.page.slug, p.owner, 'Note to self')
    expect(notice).not.toHaveBeenCalled()

    const t = await comment(p.page.slug, p.member, 'Looks good')
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith('owner@example.com', {
      from: 'Mia Member',
      title: 'Launch plan',
      link: `http://localhost:5177/a/${p.page.slug}?comments`,
      body: 'Looks good',
      reply: false,
      version: 1,
    })

    notice.mockClear()
    await db.delete(schema.rateLimits)
    await comment(p.page.slug, p.viewer, 'Agreed', t.id)
    expect(notice.mock.calls.map(([to, n]) => [to, n.reply]).sort()).toEqual([
      ['owner@example.com', false],
      [p.member.email, true],
    ])
  })

  it('sends at most one email per page and person in a while', async () => {
    const p = await people()
    await comment(p.page.slug, p.member, 'One')
    await comment(p.page.slug, p.member, 'Two')
    await comment(p.page.slug, p.viewer, 'Three')
    expect(notice).toHaveBeenCalledTimes(1)

    // Another page is counted apart
    const other = await createPage(p.owner, { organizationId: p.org.id, visibility: 'organization' })
    await comment(other.slug, p.member, 'Elsewhere')
    expect(notice).toHaveBeenCalledTimes(2)
  })

  it("doesn't email a thread's author who lost access", async () => {
    const p = await people('private')
    const t = await comment(p.page.slug, p.viewer, 'Question')
    await db.delete(schema.artifactShares).where(eq(schema.artifactShares.email, p.viewer.email))
    notice.mockClear()
    await db.delete(schema.rateLimits)
    await comment(p.page.slug, p.editor, 'Answer', t.id)
    expect(notice.mock.calls.map(([to]) => to)).toEqual(['owner@example.com'])
  })

  it('sends nothing without email', async () => {
    env.smtp.host = ''
    const p = await people()
    await comment(p.page.slug, p.member, 'Hello')
    expect(notice).not.toHaveBeenCalled()
  })

  it('keeps the comment when the email fails', async () => {
    notice.mockRejectedValueOnce(new Error('SMTP down'))
    const p = await people()
    expect((await post(p.page.slug, p.member, { body: 'Hello' })).status).toBe(201)
  })
})

describe('new comments', () => {
  it('counts what others wrote since you last opened the comments', async () => {
    const p = await people()
    await comment(p.page.slug, p.owner, 'Mine')
    await comment(p.page.slug, p.member, 'Theirs')

    const card = async (user: TestUser, workspace: string) => {
      const items = await (await call(`/api/artifacts?workspace=${workspace}`, { cookie: user.cookie })).json()
      return items.find((a: { slug: string }) => a.slug === p.page.slug)
    }
    expect(await card(p.owner, p.org.id)).toMatchObject({ comments: 2, unreadComments: 1 })
    expect(await card(p.viewer, 'shared')).toMatchObject({ comments: 2, unreadComments: 2 })

    expect((await list(p.page.slug, p.owner)).seenAt).toBeNull()
    expect((await call(`${base(p.page.slug)}/seen`, { method: 'POST', cookie: p.owner.cookie })).status).toBe(204)
    expect(await card(p.owner, p.org.id)).toMatchObject({ comments: 2, unreadComments: 0 })
    expect((await list(p.page.slug, p.owner)).seenAt).not.toBeNull()

    await comment(p.page.slug, p.viewer, 'New one')
    const page = await (await call(`/api/artifacts/${p.page.slug}`, { cookie: p.owner.cookie })).json()
    expect(page.comments).toEqual({ total: 3, unread: 1 })
    expect((await call(`${base(p.page.slug)}/seen`, { method: 'POST', cookie: p.outsider.cookie })).status).toBe(404)
  })
})

describe('rate limit', () => {
  it('limits how many comments one account writes', async () => {
    env.rateLimits = 'comment=2/1h'
    const p = await people()
    await comment(p.page.slug, p.member, 'One')
    await comment(p.page.slug, p.member, 'Two')
    const res = await post(p.page.slug, p.member, { body: 'Three' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect((await res.json()).error).toMatch(/a lot of comments/)
    // Others are counted apart
    await comment(p.page.slug, p.viewer, 'Mine')
  })
})

describe('comments over MCP', () => {
  it('reads threads, replies and resolves as the connected person', async () => {
    const p = await people()
    const t = await comment(p.page.slug, p.member, 'The table needs totals\nand a legend')
    const done = await comment(p.page.slug, p.member, 'Old point')
    await call(`${base(p.page.slug)}/${done.id}`, { method: 'PATCH', cookie: p.owner.cookie, json: { resolved: true } })
    const { access_token: token } = await connectAgent(p.owner, p.org.id, 'claude-code')

    const read = await callTool(token, 'get_artifact', { artifact_id: p.page.slug })
    expect(read.text).toContain('Comments: 1 open thread; read them with list_comments')

    const listed = await callTool(token, 'list_comments', { artifact_id: p.page.slug })
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain('1 open thread and 1 resolved (pass include_resolved to see it)')
    expect(listed.text).toContain(`comment_id: ${t.id}, Mia Member, on version 1`)
    expect(listed.text).toContain('    The table needs totals\n    and a legend')
    expect(listed.text).not.toContain('Old point')
    const all = await callTool(token, 'list_comments', { artifact_id: p.page.slug, include_resolved: true })
    expect(all.text).toContain('Old point')
    expect(all.text).toContain('[resolved by Olivia Owner')

    const replied = await callTool(token, 'reply_comment', { artifact_id: p.page.slug, comment_id: t.id, body: 'Added both in version 2' })
    expect(replied.isError).toBe(false)
    const { threads } = await list(p.page.slug, p.member)
    expect(threads[0].replies[0]).toMatchObject({ body: 'Added both in version 2', author: 'Olivia Owner', postedWith: 'claude-code' })
    expect(notice).toHaveBeenCalledWith(p.member.email, expect.objectContaining({ from: 'Olivia Owner', reply: true }))

    const resolved = await callTool(token, 'resolve_comment', { artifact_id: p.page.slug, comment_id: t.id })
    expect(resolved.text).toContain('Resolved the thread')
    expect((await list(p.page.slug, p.member)).threads[0].resolved).not.toBeNull()

    const added = await callTool(token, 'add_comment', { artifact_id: p.page.slug, body: 'Version 2 is up' })
    expect(added.text).toMatch(/comment_id: [0-9a-f-]{36}/)
    expect((await list(p.page.slug, p.member)).threads.at(-1)).toMatchObject({ body: 'Version 2 is up', postedWith: 'claude-code' })
  })

  it('pages through threads', async () => {
    const p = await people()
    for (const n of [1, 2, 3]) await comment(p.page.slug, p.member, `Point ${n}`)
    const { access_token: token } = await connectAgent(p.owner, p.org.id)
    const first = await callTool(token, 'list_comments', { artifact_id: p.page.slug, limit: 2 })
    expect(first.text).toContain('Point 2')
    expect(first.text).not.toContain('Point 3')
    const cursor = first.text.match(/cursor: (\S+)$/)![1]
    const second = await callTool(token, 'list_comments', { artifact_id: p.page.slug, limit: 2, cursor })
    expect(second.text).toContain('Point 3')
    expect(second.text).not.toContain('Point 1')
    expect((await callTool(token, 'list_comments', { artifact_id: p.page.slug, cursor: 'bogus' })).isError).toBe(true)
  })

  it('applies the same access rules', async () => {
    const p = await people('private')
    const t = await comment(p.page.slug, p.viewer, 'Question')
    const { access_token: outsider } = await connectAgent(p.outsider)
    for (const [name, args] of [
      ['list_comments', {}],
      ['add_comment', { body: 'Hi' }],
      ['reply_comment', { comment_id: t.id, body: 'Hi' }],
      ['resolve_comment', { comment_id: t.id }],
    ] as const) {
      const res = await callTool(outsider, name, { artifact_id: p.page.slug, ...args })
      expect(res.isError).toBe(true)
      expect(res.text).toContain('No page you can open')
    }

    // A viewer's agent can comment but not resolve someone else's thread
    const other = await comment(p.page.slug, p.editor, 'Editor note')
    const { access_token: viewer } = await connectAgent(p.viewer)
    expect((await callTool(viewer, 'resolve_comment', { artifact_id: p.page.slug, comment_id: other.id })).isError).toBe(true)
    expect((await callTool(viewer, 'resolve_comment', { artifact_id: p.page.slug, comment_id: t.id })).isError).toBe(false)
    expect((await callTool(viewer, 'reply_comment', { artifact_id: p.page.slug, comment_id: '00000000-0000-0000-0000-000000000000', body: 'x' })).isError).toBe(
      true,
    )
  })

  it('counts toward the comment limit', async () => {
    env.rateLimits = 'comment=1/1h'
    const p = await people()
    const { access_token: token } = await connectAgent(p.owner, p.org.id)
    expect((await callTool(token, 'add_comment', { artifact_id: p.page.slug, body: 'One' })).isError).toBe(false)
    const refused = await callTool(token, 'add_comment', { artifact_id: p.page.slug, body: 'Two' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('limit of 1 comments per hour')
  })
})

describe('comments on an element', () => {
  const anchor = {
    version: 1,
    selector: '#revenue > h2',
    snippet: '  Revenue\n by   month ',
    path: 'index.html',
    rect: { x: 0.1, y: 0.25123456, w: 0.5, h: 0.05 },
  }
  type Anchored = { anchor: unknown }

  it('stores the anchor of a new thread and returns it', async () => {
    const p = await people()
    const res = await post(p.page.slug, p.member, { body: 'Wrong axis', anchor: { ...anchor, extra: 'dropped' } })
    expect(res.status).toBe(201)
    const created = await res.json()
    const stored = { version: 1, selector: '#revenue > h2', snippet: 'Revenue by month', path: 'index.html', rect: { x: 0.1, y: 0.2512, w: 0.5, h: 0.05 } }
    expect(created.anchor).toEqual(stored)
    const { threads } = await list(p.page.slug, p.viewer)
    expect((threads[0] as Thread & Anchored).anchor).toEqual(stored)
    // Whole-page comments have none
    const plain = await comment(p.page.slug, p.member, 'Looks good')
    expect((plain as Comment & Anchored).anchor).toBeNull()
  })

  it('checks the anchor as untrusted input', async () => {
    const p = await people()
    const bad: [unknown, RegExp][] = [
      ['#a', /not valid/],
      [[anchor], /not valid/],
      [{ ...anchor, version: 2 }, /version the page has, from 1 to 1/],
      [{ ...anchor, version: 0 }, /version the page has/],
      [{ ...anchor, version: 1.5 }, /version the page has/],
      [{ ...anchor, selector: '' }, /CSS selector/],
      [{ ...anchor, selector: 42 }, /CSS selector/],
      [{ ...anchor, selector: 'a'.repeat(501) }, /under 500 characters/],
      [{ ...anchor, selector: 'h1\u0000' }, /control characters/],
      [{ ...anchor, selector: 'h1\u001b[31m' }, /control characters/],
      [{ ...anchor, snippet: 'x'.repeat(201) }, /under 200 characters/],
      [{ ...anchor, snippet: 'bell\u0007' }, /control characters/],
      [{ ...anchor, snippet: 7 }, /must be text/],
      [{ ...anchor, path: '../secret.html' }, /HTML files/],
      [{ ...anchor, path: 'style.css' }, /HTML files/],
      [{ ...anchor, path: '/index.html' }, /HTML files/],
      [{ ...anchor, rect: { x: 2, y: 0, w: 0, h: 0 } }, /four numbers from 0 to 1/],
      [{ ...anchor, rect: { x: 0, y: 0, w: 0 } }, /four numbers/],
      [{ ...anchor, rect: 'top' }, /four numbers/],
    ]
    for (const [value, error] of bad) {
      const res = await post(p.page.slug, p.member, { body: 'Hi', anchor: value })
      expect(res.status, JSON.stringify(value)).toBe(400)
      const json = await res.json()
      expect(json.field).toBe('anchor')
      expect(json.error).toMatch(error)
    }
    // Whitespace in the snippet is folded, not refused; a missing path and version mean the entry and the current one
    const ok = await post(p.page.slug, p.member, { body: 'Hi', anchor: { selector: 'main', snippet: 'a\tb\nc' } })
    expect(ok.status).toBe(201)
    expect((await ok.json()).anchor).toEqual({ version: 1, selector: 'main', snippet: 'a b c', path: 'index.html' })
    expect((await list(p.page.slug, p.owner)).threads).toHaveLength(1)
  })

  it("won't pin a reply, and only people who can open the page can pin", async () => {
    const p = await people()
    const t = await comment(p.page.slug, p.member, 'Start')
    const reply = await post(p.page.slug, p.member, { body: 'Reply', replyTo: t.id, anchor })
    expect(reply.status).toBe(400)
    expect((await reply.json()).error).toMatch(/reply can't be pinned/)
    expect((await post(p.page.slug, p.outsider, { body: 'Hi', anchor })).status).toBe(404)
    expect((await post(p.page.slug, null, { body: 'Hi', anchor })).status).toBe(401)
  })

  it('accepts anchors on older versions, and keeps them when the comment is edited', async () => {
    const p = await people()
    await publish({
      userId: p.owner.id,
      email: p.owner.email,
      organizationId: p.org.id,
      clientName: 'test',
      title: 'Launch plan',
      html: '<p>v2</p>',
      slug: p.page.slug,
    })
    const res = await post(p.page.slug, p.member, { body: 'On the old one', anchor: { ...anchor, version: 1, path: 'pages/team.htm' } })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created).toMatchObject({ version: 2, anchor: { version: 1, path: 'pages/team.htm' } })
    const edited = await call(`${base(p.page.slug)}/${created.id}`, { method: 'PATCH', cookie: p.member.cookie, json: { body: 'Edited' } })
    expect((await edited.json()).anchor).toMatchObject({ selector: '#revenue > h2' })
  })

  it('gives agents the anchor, and lets them pin a comment', async () => {
    const p = await people()
    await post(p.page.slug, p.member, { body: 'Wrong axis', anchor })
    const { access_token: token } = await connectAgent(p.owner, p.org.id, 'claude-code')
    const listed = await callTool(token, 'list_comments', { artifact_id: p.page.slug })
    expect(listed.text).toContain(
      '[about the element "#revenue > h2" in index.html of version 1, which read "Revenue by month", 10% across and 25% down the page]',
    )
    expect(listed.text).toContain('    Wrong axis')

    const added = await callTool(token, 'add_comment', {
      artifact_id: p.page.slug,
      body: 'Fixed the axis',
      anchor: { selector: '#revenue canvas', snippet: 'Chart' },
    })
    expect(added.isError).toBe(false)
    expect(added.text).toContain('pinned to "#revenue canvas" in index.html')
    const { threads } = await list(p.page.slug, p.member)
    expect((threads.at(-1) as Thread & Anchored).anchor).toEqual({ version: 1, selector: '#revenue canvas', snippet: 'Chart', path: 'index.html' })

    const refused = await callTool(token, 'add_comment', { artifact_id: p.page.slug, body: 'x', anchor: { selector: 'h1', version: 3 } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/version the page has/)
    const control = await callTool(token, 'add_comment', { artifact_id: p.page.slug, body: 'x', anchor: { selector: 'h1', snippet: 'a\u0000b' } })
    expect(control.isError).toBe(true)
  })
})
