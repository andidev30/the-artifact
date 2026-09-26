import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { signInLink, signUp, uniqueEmail } from './helpers'

test('sign up with a magic link, create an organization, land in its workspace', async ({ page }) => {
  const email = uniqueEmail('signup')
  const slug = `e2e-${randomBytes(4).toString('hex')}`

  await signUp(page, email, '/signup?plan=organization')

  // Workspace step: the organization plan preselects "My team"
  await expect(page.getByRole('heading', { name: /Who is this workspace for/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /My team/ })).toBeChecked()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Organization step, with a live address check
  await expect(page.getByRole('heading', { name: 'Name your organization' })).toBeVisible()
  await page.getByLabel('Organization name').fill('E2E Team')
  await expect(page.getByLabel('Address')).toHaveValue('e2e-team')
  await page.getByLabel('Address').fill('login')
  await expect(page.locator('#slug-status')).toHaveText(/reserved/)
  await expect(page.getByRole('button', { name: 'Create organization' })).toBeDisabled()
  await page.getByLabel('Address').fill(slug)
  await expect(page.locator('#slug-status')).toHaveText('This address is available.')
  await page.getByRole('button', { name: 'Create organization' }).click()

  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expect(page.getByText('E2E Team is ready.')).toBeVisible()
  await page.getByRole('link', { name: 'Go to your pages' }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toBeVisible()
  await expect(page.getByText('Everything published to E2E Team. Your role: Owner.')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'E2E Team' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText(email)).toBeVisible()

  // Onboarding runs once
  await page.goto('/onboarding')
  await expect(page).toHaveURL(/\/app$/)

  // Log out and the gallery is gone
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/$/)
  expect((await page.request.get('/api/me')).status()).toBe(401)
})

test('a used sign-in link shows an error on the login page', async ({ page, browser }) => {
  const email = uniqueEmail('reuse')
  await signUp(page, email)

  // Open the same link again in another browser
  const used = await signInLink(page.request, email)
  const other = await browser.newContext()
  const otherPage = await other.newPage()
  await otherPage.goto(used)
  await expect(otherPage).toHaveURL(/\/login\?error=link_invalid/)
  await expect(otherPage.getByRole('alert')).toHaveText(/already been used/)
  await other.close()
})
