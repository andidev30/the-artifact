import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { selfHostedAccountCount } from '../../apps/api/test/e2e-db.ts'
import { signUp, uniqueEmail } from '../helpers'

test('the first account on a fresh install becomes its admin and names the server organization', async ({ page }) => {
  // Global setup empties this server's database; anything here would make this account a later one
  expect(await selfHostedAccountCount()).toBe(0)

  // No marketing pages on a self-hosted install
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)

  const email = uniqueEmail('sh-first')
  await signUp(page, email)

  // Straight to naming the organization: there is no Just me / My team choice to make
  await expect(page.getByRole('heading', { name: /Name your organization/ })).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  const rail = page.getByRole('list', { name: 'Setup progress' })
  await expect(rail).toContainText('Name your organization')
  await expect(rail).not.toContainText('Choose a workspace')
  await expect(page.getByRole('button', { name: 'Skip, just me for now' })).toBeVisible()

  await page.getByLabel('Organization name').fill('Self Hosted Team')
  await page.getByLabel('Address').fill(`sh-${randomBytes(4).toString('hex')}`)
  await expect(page.locator('#slug-status')).toHaveText('This address is available.')
  await page.getByRole('button', { name: 'Create organization' }).click()

  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expect(page.getByText('Self Hosted Team is ready.')).toBeVisible()
  await page.getByRole('link', { name: 'Go to your pages' }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText('Everything published to Self Hosted Team. Your role: Owner.')).toBeVisible()

  await page.getByRole('button', { name: /^Account:/ }).click()
  await expect(page.getByRole('link', { name: 'Server admin' })).toBeVisible()

  // Onboarding runs once
  await page.goto('/onboarding')
  await expect(page).toHaveURL(/\/app$/)
})
