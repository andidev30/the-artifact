import { expect, type Page, test } from '@playwright/test'
import { createSelfHostedAccount } from '../../apps/api/test/e2e-db.ts'
import { expectAccessible } from '../axe'
import { openSignInLink, signInLink, uniqueEmail } from '../helpers'

// A valid key needs a signing key whose public key is in the code, which e2e doesn't have, so a key
// that works is covered by apps/api/test/integration/licenses.test.ts. This covers the screen.

async function signInAsAdmin(page: Page) {
  const email = uniqueEmail('sh-license')
  await createSelfHostedAccount(email, { isAdmin: true, onboarded: true })
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  // Continue signs in with a request of its own; going on before it lands would leave the session unset
  await expect(page).toHaveURL(/\/app$/)
}

test('an admin sees there is no license and a key that is not one is refused, by keyboard alone', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Server admin', exact: true })).toBeVisible()

  const section = page.locator('#license')
  await expect(section.getByRole('heading', { name: 'License' })).toBeVisible()
  await expect(section.getByText(/No license key\. Enterprise features are off/)).toBeVisible()
  await expect(section.getByRole('link', { name: 'About licenses' })).toHaveAttribute('href', '/docs/licenses')

  // The rail reaches the section
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'License' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#license$/)

  const field = section.getByLabel('License key')
  const save = section.getByRole('button', { name: 'Save key' })
  await expect(save).toBeDisabled()
  await field.focus()
  await page.keyboard.type('not a license key')
  await page.keyboard.press('Tab')
  await expect(save).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(section.getByRole('alert')).toHaveText(/This is not a license key/)
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toHaveAttribute('aria-describedby', /license-status/)
  await expectAccessible(page, 'server admin, license with an error', { include: '#license' })

  // Typing again clears the error
  await field.focus()
  await page.keyboard.press('End')
  await page.keyboard.type('x')
  await expect(section.getByRole('alert')).toHaveCount(0)
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')

  expect((await page.request.get('/api/admin/license')).status()).toBe(200)
  expect((await page.request.get('/api/admin/issued-licenses')).status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'License keys' })).toHaveCount(0)
})

test('the license section is accessible', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/admin#license')
  await expect(page.locator('#license').getByText(/No license key/)).toBeVisible()
  await expectAccessible(page, 'server admin, license', { include: '#license' })
})
