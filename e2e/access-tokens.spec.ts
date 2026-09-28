import { expect, test } from '@playwright/test'
import { signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><title>Report</title><h1>All tests passed</h1>'

test('create an access token in settings, publish with it, and revoke it', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('tokens'))
  await page.goto('/settings#tokens')

  const section = page.locator('section#tokens')
  await expect(section.getByRole('heading', { name: 'Access tokens' })).toBeVisible()
  await section.getByLabel('Name').fill('Nightly report')
  await expect(section.getByLabel('Expires after')).toHaveValue('90')
  await section.getByRole('button', { name: 'Create token' }).click()

  // Shown once, with its prefix
  const shown = section.locator('.settings-token-new')
  await expect(shown).toContainText('Copy the token for Nightly report now.')
  const token = (await shown.locator('code').textContent())?.trim() ?? ''
  expect(token).toMatch(/^art_[A-Za-z0-9_-]{43}$/)

  const publish = () => page.request.post('/api/publish', { headers: { authorization: `Bearer ${token}` }, data: { title: 'Nightly report', html: HTML } })
  const res = await publish()
  expect(res.status()).toBe(201)
  const { url } = (await res.json()) as { url: string }
  expect(url).toMatch(/\/a\/[a-z0-9]+$/)

  await section.getByRole('button', { name: 'Done' }).click()
  await expect(shown).toHaveCount(0)
  const row = section.getByRole('listitem').filter({ hasText: 'Nightly report' })
  await expect(row).toContainText('Publishes to Personal')
  await expect(row).toContainText(/Expires in 3 months/)

  // After a reload the token itself is gone from the page, and its last use shows
  await page.reload()
  await expect(row).toContainText('Last used')
  await expect(page.getByText(token)).toHaveCount(0)

  await row.getByRole('button', { name: 'Revoke Nightly report' }).click()
  await row.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(row).toHaveCount(0)
  expect((await publish()).status()).toBe(401)
})
