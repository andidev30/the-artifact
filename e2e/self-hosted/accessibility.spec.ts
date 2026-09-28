import { expect, test } from '@playwright/test'
import { expectAccessible } from '../axe'
import { openSignInLink, signInLink, uniqueEmail } from '../helpers'

// Screens only a self-hosted install has. Runs after first-account.spec.ts, so this account starts in
// its personal workspace.
test('new organization form', async ({ page }) => {
  const email = uniqueEmail('sh-a11y-new-org')
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/app$/)

  await page.goto('/organizations/new')
  await expect(page.getByRole('heading', { level: 1, name: 'Create an organization' })).toBeVisible()
  await expectAccessible(page, 'new organization')

  // With the keyboard: the name suggests an address, which is checked as it is typed
  await page.getByLabel('Organization name').focus()
  await page.keyboard.type('Accessible Co')
  await expect(page.getByLabel('Address')).toHaveValue('accessible-co')
  await expect(page.getByText('This address is available.')).toBeVisible()
  await expectAccessible(page, 'new organization, address available')
  await page.getByLabel('Address').fill('admin')
  await expect(page.getByLabel('Address')).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page, 'new organization, address not allowed')
})
