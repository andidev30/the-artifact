import { expect, test } from '@playwright/test'
import { grantInstanceAdmin } from '../apps/api/test/e2e-db.ts'
import { signUpPersonal, uniqueEmail } from './helpers'

test('an instance admin finds someone, suspends them and lets them back in', async ({ page, browser }) => {
  // Someone to manage, in their own browser
  const memberEmail = uniqueEmail('member')
  const other = await browser.newContext()
  const memberPage = await other.newPage()
  await signUpPersonal(memberPage, memberEmail)

  const adminEmail = uniqueEmail('admin')
  await signUpPersonal(page, adminEmail)
  // Regular people see no Server admin link and can't open the area
  await page.getByRole('button', { name: /^Account:/ }).click()
  await expect(page.getByRole('link', { name: 'Server admin' })).toHaveCount(0)
  expect((await page.request.get('/api/admin/overview')).status()).toBe(403)

  await grantInstanceAdmin(adminEmail)
  await page.reload()
  await page.getByRole('button', { name: /^Account:/ }).click()
  await page.getByRole('link', { name: 'Server admin' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Server admin', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

  // Find the member and suspend them, confirming in the page
  await page.getByLabel('Search people').fill(memberEmail)
  const people = page.locator('#people')
  await expect(people.getByText('Showing 1 of 1 person')).toBeVisible()
  await people.getByRole('button', { name: 'Manage' }).click()
  await people.getByRole('button', { name: 'Suspend', exact: true }).click()
  await expect(people.getByText(/signed out everywhere/)).toBeVisible()
  await people.getByRole('group', { name: 'Confirm: Suspend' }).getByRole('button', { name: 'Suspend', exact: true }).click()
  await expect(people.locator('.admin-badge-bad')).toBeVisible()

  // Their session is gone
  expect((await memberPage.request.get('/api/me')).status()).toBe(401)

  await people.getByRole('button', { name: 'Unsuspend', exact: true }).click()
  await expect(people.locator('.admin-badge-bad')).toHaveCount(0)
  await other.close()
})

test('on the hosted service, License keys says why it cannot issue keys without a signing key', async ({ page }) => {
  const email = uniqueEmail('license-admin')
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  await page.goto('/admin')

  const rail = page.getByRole('navigation', { name: 'Admin sections' })
  await expect(rail.getByRole('link', { name: 'License keys' })).toBeVisible()
  // The self-hosted License section isn't here
  await expect(rail.getByRole('link', { name: 'License', exact: true })).toHaveCount(0)
  expect((await page.request.get('/api/admin/license')).status()).toBe(404)

  await rail.getByRole('link', { name: 'License keys' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#license-keys$/)
  const section = page.locator('#license-keys')
  await expect(section.getByRole('heading', { name: 'License keys' })).toBeVisible()
  await expect(section.getByRole('note')).toHaveText(/can’t issue keys yet.*LICENSE_SIGNING_KEY/)
  await expect(section.getByRole('button', { name: 'Issue key' })).toHaveCount(0)
})
