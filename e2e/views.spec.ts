import { expect, test } from '@playwright/test'
import { fromApp, connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><title>Roadmap</title><h1>Roadmap</h1>'

test('owners see how often a page was opened and who opened it', async ({ page, browser }) => {
  const friend = uniqueEmail('views-friend')
  await signUpPersonal(page, uniqueEmail('views-owner'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Roadmap', html: HTML })
  const shared = await page.request.post(`/api/artifacts/${slug}/sharing/people`, {
    headers: fromApp(page),
    data: { emails: [friend], role: 'viewer', notify: false },
  })
  expect(shared.ok()).toBe(true)

  // Someone it was shared with opens it; people who can only view don't see the views
  const context = await browser.newContext()
  const other = await context.newPage()
  await signUpPersonal(other, friend)
  await other.goto(`/a/${slug}`)
  await expect(other.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  await expect(other.getByRole('button', { name: /^Views/ })).toHaveCount(0)
  await context.close()

  // The owner's own visit doesn't count
  await page.goto(`/a/${slug}`)
  await expect(page.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  await page.getByRole('button', { name: /^Views/ }).click()
  const panel = page.getByRole('complementary', { name: 'Views' })
  await expect(panel.locator('.views-total')).toHaveText('1 view')
  await expect(panel.getByText(friend)).toBeVisible()
  await expect(panel.getByText('Version 1', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Views/ })).toBeFocused()
})

test('visits through a shared link are counted without saying who', async ({ page, browser }) => {
  await signUpPersonal(page, uniqueEmail('views-link'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Roadmap', html: HTML, visibility: 'link' })

  const context = await browser.newContext()
  const visitor = await context.newPage()
  await visitor.goto(`/a/${slug}`)
  await expect(visitor.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Roadmap' })).toBeVisible()
  await context.close()

  await page.goto(`/a/${slug}`)
  await page.getByRole('button', { name: /^Views/ }).click()
  const panel = page.getByRole('complementary', { name: 'Views' })
  await expect(panel.locator('.views-total')).toHaveText('1 view')
  await expect(panel.getByText(/Nobody has opened it as themselves/)).toBeVisible()
  await expect(panel.getByText(/Visits through the link are counted without saying who/)).toBeVisible()
})
