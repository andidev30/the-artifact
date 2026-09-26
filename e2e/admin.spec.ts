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
  // Regular people see no Admin link and can't open the area
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)
  expect((await page.request.get('/api/admin/overview')).status()).toBe(403)

  await grantInstanceAdmin(adminEmail)
  await page.reload()
  await page.getByRole('link', { name: 'Admin', exact: true }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible()
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
