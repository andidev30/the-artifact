import { afterEach, describe, expect, it } from 'vitest'
import { publish } from '../../src/artifacts.js'
import { contentCsp } from '../../src/content.js'
import { env } from '../../src/env.js'
import { call, createPage, createUser } from './helpers.js'

const HELPER = '__artifactCommentHelper'
const saved = { contentOrigin: env.contentOrigin }
afterEach(() => {
  Object.assign(env, saved)
})

const frame = (path: string, cookie?: string) => call(path, { cookie, headers: { 'sec-fetch-dest': 'iframe' } })

describe('the comment helper in page files', () => {
  it('is added to HTML only when the address asks for it, with the same sandbox', async () => {
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link', html: '<!doctype html><title>T</title><h1>Hello</h1>' })
    const plain = await frame(`/api/artifacts/${page.slug}/v/1/`)
    expect(plain.status).toBe(200)
    expect(await plain.text()).not.toContain(HELPER)

    const helped = await frame(`/api/artifacts/${page.slug}/v/1/~comments/`)
    expect(helped.status).toBe(200)
    const html = await helped.text()
    expect(html.startsWith('<!doctype html><script>')).toBe(true)
    expect(html).toContain(HELPER)
    expect(html.endsWith('<title>T</title><h1>Hello</h1>')).toBe(true)
    expect(helped.headers.get('content-security-policy')).toBe(contentCsp())
    expect(helped.headers.get('etag')).not.toBe(plain.headers.get('etag'))

    // Revalidates against its own ETag
    const again = await call(`/api/artifacts/${page.slug}/v/1/~comments/index.html`, { headers: { 'if-none-match': helped.headers.get('etag')! } })
    expect(again.status).toBe(304)
  })

  it('goes into every HTML file of a page, but nothing else', async () => {
    const owner = await createUser()
    const page = await publish({
      userId: owner.id,
      email: owner.email,
      organizationId: null,
      clientName: 'test',
      title: 'Site',
      html: '<!doctype html><a href="team.html">Team</a>',
      files: [
        { path: 'team.html', content: '<h1>Team</h1>' },
        { path: 'app.js', content: 'console.log(1)' },
      ],
      visibility: 'link',
    })
    const team = await call(`/api/artifacts/${page.slug}/v/1/~comments/team.html`)
    expect(team.status).toBe(200)
    const html = await team.text()
    expect(html.startsWith('<script>')).toBe(true)
    expect(html.endsWith('<h1>Team</h1>')).toBe(true)
    const js = await call(`/api/artifacts/${page.slug}/v/1/~comments/app.js`)
    expect(await js.text()).toBe('console.log(1)')
  })

  it('keeps the mark through the link token redirect, and checks access as before', async () => {
    const owner = await createUser()
    const outsider = await createUser()
    const page = await createPage(owner, { visibility: 'private' })
    const res = await frame(`/api/artifacts/${page.slug}/v/1/~comments/`, owner.cookie)
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toMatch(new RegExp(`^/api/artifacts/${page.slug}/v/1/~[^/]+/~comments/$`))
    const followed = await frame(location)
    expect(followed.status).toBe(200)
    expect(await followed.text()).toContain(HELPER)
    // The mark before the token works too
    const token = location.split('/')[6]
    expect((await frame(`/api/artifacts/${page.slug}/v/1/~comments/${token}/`)).status).toBe(200)

    expect((await frame(`/api/artifacts/${page.slug}/v/1/~comments/`, outsider.cookie)).status).toBe(404)
    expect((await frame(`/api/artifacts/${page.slug}/v/1/~comments/`)).status).toBe(404)
    expect((await frame(`/api/artifacts/${page.slug}/v/1/~comments/~comments/`, owner.cookie)).status).toBe(404)
    expect((await frame(`${location}~other/`)).status).toBe(404)
  })

  it('keeps the mark on the way to the content origin', async () => {
    env.contentOrigin = 'http://content.test'
    const owner = await createUser()
    const page = await createPage(owner, { visibility: 'link' })
    const res = await frame(`/api/artifacts/${page.slug}/v/1/~comments/`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`http://content.test/api/artifacts/${page.slug}/v/1/~comments/`)
  })
})
