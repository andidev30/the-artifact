import { expect, test, type Page } from '@playwright/test'
import { fromApp, connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

// The hosted e2e server serves pages from CONTENT_ORIGIN (playwright.config.ts): the API's address on
// 127.0.0.1, while the app is on localhost, a different site whose cookies the browser keeps to itself.

const HTML = '<!doctype html><link rel="stylesheet" href="site.css"><h1>Quarterly numbers</h1><script src="app.js"></script>'
const FILES = [
  { path: 'site.css', content: 'h1 { color: rgb(1, 2, 3) }' },
  { path: 'app.js', content: 'document.body.dataset.ran = "yes"' },
]

function viewerFrame(page: Page) {
  return page.frames().find((f) => f !== page.mainFrame() && f.url() !== 'about:blank')
}

test('pages load from the content origin with a token, and the app keeps its cookies', async ({ page, browser, baseURL }, testInfo) => {
  const contentOrigin = testInfo.project.metadata.contentOrigin as string
  await signUpPersonal(page, uniqueEmail('content'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Numbers', html: HTML, files: FILES })

  // A restricted page: the owner's frame goes on to the content origin under a link token
  await page.goto(`/a/${slug}`)
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'Quarterly numbers' })).toBeVisible()
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes')
  await expect(frame.getByRole('heading', { name: 'Quarterly numbers' })).toHaveCSS('color', 'rgb(1, 2, 3)')
  // Signed in, so the comment helper's mark follows the token
  expect(viewerFrame(page)?.url()).toMatch(new RegExp(`^${contentOrigin}/api/artifacts/${slug}/v/1/~[^/]+/~comments/$`))

  const cookies = await page.context().cookies()
  expect(cookies.some((c) => c.name === 'session' && baseURL?.includes(c.domain))).toBe(true)
  expect(await page.context().cookies(contentOrigin)).toEqual([])

  // The content origin is not the app: no sign-in, no API
  expect((await page.request.get(`${contentOrigin}/login`)).status()).toBe(404)
  expect((await page.request.get(`${contentOrigin}/api/me`)).status()).toBe(404)
  expect((await page.request.get(`${contentOrigin}/api/artifacts/${slug}/v/1/`)).status()).toBe(404)

  // A link with a password: the visitor's frame carries the grant in its path, not a cookie
  const shared = await page.request.patch(`/api/artifacts/${slug}`, { headers: fromApp(page), data: { visibility: 'link', linkPassword: 'open sesame' } })
  expect(shared.ok()).toBe(true)
  const visitor = await browser.newContext()
  const visitorPage = await visitor.newPage()
  await visitorPage.goto(`/a/${slug}`)
  await expect(visitorPage.getByRole('heading', { name: 'This page needs a password' })).toBeVisible()
  await visitorPage.getByLabel('Password', { exact: true }).fill('open sesame')
  await visitorPage.keyboard.press('Enter')
  await expect(visitorPage.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Quarterly numbers' })).toBeVisible()
  expect(viewerFrame(visitorPage)?.url()).toMatch(new RegExp(`^${contentOrigin}/api/artifacts/${slug}/v/1/~[^/]+/$`))
  expect(await visitor.cookies(contentOrigin)).toEqual([])
  await visitor.close()
})
