import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { SELF_HOSTED_SETUP_CODE, selfHostedAccountCount } from '../../apps/api/test/e2e-db.ts'
import { expectAccessible } from '../axe'
import { signInLink, uniqueEmail } from '../helpers'

test('the first account on a fresh install becomes its admin and names the server organization', async ({ page }) => {
  // Global setup empties this server's database; anything here would make this account a later one
  expect(await selfHostedAccountCount()).toBe(0)

  // No marketing pages on a self-hosted install
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)

  const email = uniqueEmail('sh-first')
  await page.goto('/signup')
  await expect(page.getByText('enter the setup code from the server log')).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()

  // The first account needs the code the server printed; a wrong one keeps the link usable
  await page.goto(await signInLink(page.request, email))
  await expectAccessible(page, 'confirm the first account')
  const code = page.getByLabel('Setup code')
  await code.fill('WRONG-CODE-0000')
  await page.getByRole('button', { name: `Continue as ${email}` }).click()
  await expect(page.getByRole('alert')).toHaveText('That setup code is wrong. Use the newest one in the server log.')
  await expect(code).toHaveAttribute('aria-invalid', 'true')
  await code.fill(SELF_HOSTED_SETUP_CODE.toLowerCase())
  await page.getByRole('button', { name: `Continue as ${email}` }).click()
  await expect(page).toHaveURL(/\/onboarding/)

  // Straight to naming the organization, with no welcome step before it
  await expect(page.getByRole('heading', { name: /Name your organization/ })).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  const rail = page.getByRole('list', { name: 'Setup progress' })
  await expect(rail).toContainText('Name your organization')
  await expect(rail).not.toContainText('Your workspace')
  await expect(page.getByRole('button', { name: 'Skip, just me for now' })).toBeVisible()
  await expectAccessible(page, 'self-hosted onboarding')

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
