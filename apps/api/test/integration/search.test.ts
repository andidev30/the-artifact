import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { db, schema } from '../../src/db/index.js'
import { env } from '../../src/env.js'
import { sha256 } from '../../src/files.js'
import { INLINE_TEXT_CHARS, indexInBackground, searchQueueIdle, staleIds } from '../../src/search.js'
import { addMember, call, callTool, connectAgent, createOrg, createPage, createUser, slugFrom, type TestUser } from './helpers.js'

type Row = { slug: string; title: string }

async function search(user: TestUser, q: string, extra = '') {
  const res = await call(`/api/artifacts?q=${encodeURIComponent(q)}${extra}`, { cookie: user.cookie })
  expect(res.status).toBe(200)
  return { rows: (await res.json()) as Row[], next: res.headers.get('X-Next-Cursor'), total: res.headers.get('X-Total-Count') }
}

const titles = async (user: TestUser, q: string, extra = '') => (await search(user, q, extra)).rows.map((r) => r.title).sort()

describe('searching inside pages', () => {
  afterEach(() => {
    indexInBackground(false)
    env.cronSecret = process.env.CRON_SECRET ?? ''
  })

  it('finds a word that is only in the body, not in markup, scripts or styles', async () => {
    const me = await createUser()
    await createPage(me, {
      title: 'Weekly report',
      html:
        '<!doctype html><html><head><title>Numbers</title><style>.zebracrossing { color: red }</style></head>' +
        '<body data-note="attributeword"><h1>Revenue</h1><p>The Quarterly&nbsp;Pineapple forecast &amp; Déjà vu</p>' +
        '<script>const secretvariable = 1</script><!-- commentword --></body></html>',
    })
    await createPage(me, { title: 'Other page' })

    expect(await titles(me, 'pineapple')).toEqual(['Weekly report'])
    // Words that start with what was typed, all of them, in any case
    expect(await titles(me, 'QUARTERLY pine')).toEqual(['Weekly report'])
    expect(await titles(me, 'déjà')).toEqual(['Weekly report'])
    expect(await titles(me, 'pineapple missingword')).toEqual([])
    for (const hidden of ['zebracrossing', 'attributeword', 'secretvariable', 'commentword', 'nbsp']) expect(await titles(me, hidden)).toEqual([])
    // Titles still match anywhere in them, as before
    expect(await titles(me, 'eekly')).toEqual(['Weekly report'])
    // Punctuation alone searches titles only, and quotes or backslashes don't break the query
    expect(await titles(me, "'\\:*&!")).toEqual([])
    expect(await titles(me, "it's o'brien a\\b <->")).toEqual([])
  })

  it('finds text in the other HTML files of a page, not in its data files', async () => {
    const me = await createUser()
    await publish({
      userId: me.id,
      email: me.email,
      organizationId: null,
      clientName: 'test',
      title: 'Site',
      html: '<!doctype html><a href="about.html">About</a>',
      files: [
        { path: 'about.html', content: '<p>Founded by Marguerite</p>' },
        { path: 'data.json', content: '{"name": "Bartholomew"}' },
      ],
    })
    expect(await titles(me, 'marguerite')).toEqual(['Site'])
    expect(await titles(me, 'bartholomew')).toEqual([])
  })

  it('searches the current version only, and follows restores', async () => {
    const me = await createUser()
    const page = await createPage(me, { title: 'Plan', html: '<p>Kangaroo</p>' })
    await publish({ userId: me.id, email: me.email, organizationId: null, clientName: 'test', title: 'Plan', html: '<p>Wombat</p>', slug: page.slug })
    expect(await titles(me, 'kangaroo')).toEqual([])
    expect(await titles(me, 'wombat')).toEqual(['Plan'])

    const res = await call(`/api/artifacts/${page.slug}/versions/1/restore`, { cookie: me.cookie, method: 'POST' })
    expect(res.status).toBe(200)
    expect(await titles(me, 'kangaroo')).toEqual(['Plan'])
    expect(await titles(me, 'wombat')).toEqual([])
  })

  it("never finds pages the person can't see in the list", async () => {
    const me = await createUser({ email: 'me@example.com' })
    const mate = await createUser({ email: 'mate@example.com' })
    const stranger = await createUser({ email: 'stranger@example.com' })
    const org = await createOrg(me, 'Acme', 'acme')
    await addMember(org.id, mate, 'member')
    const word = '<p>Aardvark</p>'
    await createPage(mate, { title: 'Team', organizationId: org.id, visibility: 'organization', html: word })
    await createPage(mate, { title: 'Mate private', organizationId: org.id, visibility: 'private', html: word })
    await createPage(mate, { title: 'Mate personal', visibility: 'link', html: word })
    const shared = await createPage(stranger, { title: 'Shared with me', html: word })
    await createPage(stranger, { title: 'Stranger private', html: word })
    await call(`/api/artifacts/${shared.slug}/sharing/people`, { cookie: stranger.cookie, json: { emails: me.email, notify: false } })

    expect(await titles(me, 'aardvark', `&workspace=${org.id}`)).toEqual(['Team'])
    expect(await titles(me, 'aardvark')).toEqual([])
    expect(await titles(me, 'aardvark', '&workspace=shared')).toEqual(['Shared with me'])
    expect((await search(me, 'aardvark', `&workspace=${org.id}`)).total).toBe('1')

    const token = (await connectAgent(me, org.id)).access_token
    const listed = await callTool(token, 'list_artifacts', { query: 'aardvark' })
    expect(listed.text).toContain('Team')
    expect(listed.text).not.toContain('Mate private')
    expect(listed.text).not.toContain('Stranger')
  })

  it("doesn't search the text of listed pages a member can't open: links with a password, a key or past their expiry", async () => {
    const me = await createUser({ email: 'me@example.com' })
    const mate = await createUser({ email: 'mate@example.com' })
    const admin = await createUser({ email: 'admin@example.com' })
    const org = await createOrg(mate, 'Acme', 'acme')
    await addMember(org.id, me, 'member')
    await addMember(org.id, admin, 'admin')
    const html = '<p>Wolverine</p>'
    await createPage(mate, { title: 'Open link', organizationId: org.id, visibility: 'link', html })
    const locked = await createPage(mate, { title: 'Password link', organizationId: org.id, visibility: 'link', html })
    const keyed = await createPage(mate, { title: 'Reset link', organizationId: org.id, visibility: 'link', html })
    const expired = await createPage(mate, { title: 'Expired link', organizationId: org.id, visibility: 'link', html })
    const shared = await createPage(mate, { title: 'Password link shared with me', organizationId: org.id, visibility: 'link', html })
    const patch = (slug: string, json: unknown) => call(`/api/artifacts/${slug}`, { cookie: mate.cookie, method: 'PATCH', json })
    expect((await patch(locked.slug, { linkPassword: 'a long password' })).status).toBe(200)
    expect((await patch(shared.slug, { linkPassword: 'a long password' })).status).toBe(200)
    expect((await patch(keyed.slug, { rotateLink: true })).status).toBe(200)
    await db
      .update(schema.artifacts)
      .set({ linkExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.artifacts.id, expired.id))
    await call(`/api/artifacts/${shared.slug}/sharing/people`, { cookie: mate.cookie, json: { emails: me.email, notify: false } })

    const all = ['Expired link', 'Open link', 'Password link', 'Password link shared with me', 'Reset link']
    // The gallery lists them all, and their titles are searched as before
    expect(await titles(me, 'link', `&workspace=${org.id}`)).toEqual(all)
    expect(await titles(me, 'wolverine', `&workspace=${org.id}`)).toEqual(['Open link', 'Password link shared with me'])
    expect((await search(me, 'wolverine', `&workspace=${org.id}`)).total).toBe('2')
    // Admins and the owner edit them all
    expect(await titles(admin, 'wolverine', `&workspace=${org.id}`)).toEqual(all)
    expect(await titles(mate, 'wolverine', `&workspace=${org.id}`)).toEqual(all)
  })

  it('searches what update_files changed, including other HTML files and a new entry', async () => {
    const me = await createUser()
    const token = (await connectAgent(me)).access_token
    const page = await createPage(me, { title: 'Dashboard', html: '<p>Chinchilla</p>' })
    let res = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'notes.html', content: '<p>Meerkat</p>' }] })
    expect(res.isError).toBe(false)
    expect(await titles(me, 'meerkat')).toEqual(['Dashboard'])
    expect(await titles(me, 'chinchilla')).toEqual(['Dashboard'])
    res = await callTool(token, 'update_files', { artifact_id: page.slug, files: [{ path: 'index.html', content: '<p>Pangolin</p>' }] })
    expect(res.isError).toBe(false)
    expect(await titles(me, 'pangolin')).toEqual(['Dashboard'])
    expect(await titles(me, 'chinchilla')).toEqual([])
  })

  it('finds a duplicated page by its text, and one indexed only after it was copied', async () => {
    const me = await createUser()
    const source = await createPage(me, { title: 'Original', html: '<p>Tapir</p>' })
    const dup = async () => {
      const res = await call(`/api/artifacts/${source.slug}/duplicate`, { cookie: me.cookie, json: { workspace: 'personal' } })
      expect(res.status).toBeLessThan(300)
    }
    await dup()
    expect(await titles(me, 'tapir')).toEqual(['Original', 'Original (copy)'])
    // A source without words yet: the copy is indexed from storage
    await db.delete(schema.artifactSearch)
    await dup()
    expect(await titles(me, 'tapir')).toEqual(['Original (copy)'])
  })

  it('applies the new workspace after a move', async () => {
    const owner = await createUser({ email: 'owner@example.com' })
    const member = await createUser({ email: 'member@example.com' })
    const org = await createOrg(owner, 'Acme', 'acme')
    await addMember(org.id, member, 'member')
    const page = await createPage(owner, { title: 'Private notes', html: '<p>Okapi</p>' })
    expect(await titles(member, 'okapi', `&workspace=${org.id}`)).toEqual([])
    const res = await call(`/api/artifacts/${page.slug}/move`, { cookie: owner.cookie, json: { workspace: org.id } })
    expect(res.status).toBe(200)
    // Restricted in the organization: still not the member's to find
    expect(await titles(member, 'okapi', `&workspace=${org.id}`)).toEqual([])
    expect(await titles(owner, 'okapi', `&workspace=${org.id}`)).toEqual(['Private notes'])
    expect(await titles(owner, 'okapi')).toEqual([])
    await call(`/api/artifacts/${page.slug}`, { cookie: owner.cookie, method: 'PATCH', json: { visibility: 'organization' } })
    expect(await titles(member, 'okapi', `&workspace=${org.id}`)).toEqual(['Private notes'])
  })

  it('pages through search results with the cursor, newest first', async () => {
    const me = await createUser()
    for (const n of [1, 2, 3, 4, 5]) await createPage(me, { title: `Page ${n}`, html: n === 4 ? '<p>nothing</p>' : '<p>Platypus</p>' })
    await createPage(me, { title: 'Platypus in the title' })

    const first = await search(me, 'platypus', '&limit=2')
    expect(first.rows.map((r) => r.title)).toEqual(['Platypus in the title', 'Page 5'])
    expect(first.total).toBe('5')
    const second = await search(me, 'platypus', `&limit=2&cursor=${first.next}`)
    expect(second.rows.map((r) => r.title)).toEqual(['Page 3', 'Page 2'])
    const third = await search(me, 'platypus', `&limit=2&cursor=${second.next}`)
    expect(third.rows.map((r) => r.title)).toEqual(['Page 1'])
    expect(third.next).toBeNull()
  })

  it('indexes long pages after publishing, and a 2 MB page without holding up the publish', async () => {
    const me = await createUser()
    const long = `<p>Narwhal</p>${'<p>filler words for a long page</p>'.repeat(Math.ceil(INLINE_TEXT_CHARS / 25))}`
    await createPage(me, { title: 'Long', html: long })
    expect(await titles(me, 'narwhal')).toEqual(['Long'])

    // On the long-running server the index is written after the publish answers
    indexInBackground()
    const para = '<div><p>Numbers for the week: <b>42</b> signups &amp; 7 refunds, and more words to read.</p><script>var x = 1</script></div>\n'
    const big = `<!doctype html><p>Axolotl</p>${para.repeat(Math.floor((2 * 1024 * 1024 - 100) / para.length))}`
    const started = performance.now()
    await createPage(me, { title: 'Big', html: big })
    const took = performance.now() - started
    await searchQueueIdle()
    expect(await titles(me, 'axolotl')).toEqual(['Big'])
    // Loose: only that indexing isn't part of it (it is done in well under this on any machine)
    expect(took).toBeLessThan(5_000)
  })

  it('indexes pages published by direct upload', async () => {
    const me = await createUser()
    const token = (await connectAgent(me)).access_token
    const html = Buffer.from(`<!doctype html><p>Quokka ${crypto.randomUUID()}</p>`)
    const manifest = [{ path: 'index.html', size: html.length, sha256: sha256(html) }]
    const prepared = await callTool(token, 'prepare_upload', { files: manifest })
    const uploadId = prepared.text.match(/upload_id: ([0-9a-f]+)/)![1]
    const url = prepared.text.match(/^curl -fsS -T '[^']+' '([^']+)'/m)?.[1]
    if (url) expect((await fetch(url, { method: 'PUT', body: new Uint8Array(html) })).status).toBe(200)
    const res = await callTool(token, 'publish_upload', { title: 'Uploaded', upload_id: uploadId, files: manifest })
    expect(res.isError).toBe(false)
    expect(await titles(me, 'quokka')).toEqual(['Uploaded'])
    slugFrom(res.text)
  })

  it('catches up on pages that were never indexed: the sweep and the backfill script', async () => {
    const me = await createUser()
    const a = await createPage(me, { title: 'A', html: '<p>Capybara</p>' })
    const b = await createPage(me, { title: 'B', html: '<p>Capybara</p>' })
    await db.delete(schema.artifactSearch)
    expect((await staleIds()).sort()).toEqual([a.id, b.id].sort())
    expect(await titles(me, 'capybara')).toEqual([])

    env.cronSecret = 'a-long-random-secret'
    const swept = await call('/api/cron/sweep', { bearer: env.cronSecret })
    expect(await swept.json()).toMatchObject({ indexed: 2 })
    expect(await titles(me, 'capybara')).toEqual(['A', 'B'])

    await db.delete(schema.artifactSearch).where(eq(schema.artifactSearch.artifactId, a.id))
    const script = fileURLToPath(new URL('../../src/scripts/backfill-search.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))
    const { stdout } = await promisify(execFile)(tsx, [script], { env: process.env })
    expect(stdout).toContain('1 page to index')
    expect(stdout).toContain('Done')
    expect(await staleIds()).toEqual([])
    expect(await titles(me, 'capybara')).toEqual(['A', 'B'])

    const again = await promisify(execFile)(tsx, [script, '--all'], { env: process.env })
    expect(again.stdout).toContain('2 pages to index')
  })
})
