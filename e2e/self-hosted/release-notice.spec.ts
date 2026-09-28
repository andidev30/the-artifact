import { expect, test } from '@playwright/test'
import { grantSelfHostedAdmin, recordLatestRelease } from '../../apps/api/test/e2e-db.ts'
import { expectAccessible } from '../axe'
import { openSignInLink, signInLink, uniqueEmail } from '../helpers'

// One test, since both halves change the server's one cached release
test('admins see a newer release with a link to its notes, and nothing once they run it', async ({ page }) => {
  const email = uniqueEmail('sh-release')
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/app$/)
  await grantSelfHostedAdmin(email)

  await recordLatestRelease('99.0.0')
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Server admin', exact: true })).toBeVisible()
  const notice = page.getByRole('region', { name: /Version 99\.0\.0 is out/ })
  await expect(notice).toBeVisible()
  await expect(notice.getByRole('link', { name: /Release notes/ })).toHaveAttribute('href', 'https://github.com/andidev30/the-artifact/releases/tag/v99.0.0')
  await expect(notice.getByRole('link', { name: 'How to upgrade' })).toHaveAttribute('href', '/docs/upgrading')
  await expectAccessible(page, 'server admin, new release')

  await recordLatestRelease('0.0.1')
  const checked = page.waitForResponse((res) => res.url().endsWith('/api/admin/release'))
  await page.reload()
  await checked
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByText(/is out\./)).toHaveCount(0)
})
