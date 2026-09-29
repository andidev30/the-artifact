import { randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from '../axe'
import { fromApp, openSignInLink, signInLink, uniqueEmail } from '../helpers'

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

async function signUp(page: Page, email: string) {
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/app$/)
}

test('the notice for someone an owner added to an organization', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('sh-a11y-adder')
  const addedEmail = uniqueEmail('sh-a11y-added')
  await signUp(page, ownerEmail)
  const context = await browser.newContext()
  const them = await context.newPage()
  await signUp(them, addedEmail)

  const org = await (
    await page.request.post('/api/organizations', { headers: fromApp(page), data: { name: 'Added Co', slug: `e2e-${randomBytes(4).toString('hex')}` } })
  ).json()
  const added = await page.request.post(`/api/organizations/${org.id}/invitations`, { headers: fromApp(page), data: { email: addedEmail, role: 'member' } })
  expect(await added.json()).toMatchObject({ added: true })

  await them.goto('/app')
  const notice = them.getByRole('region', { name: 'Organizations you were added to' })
  await expect(notice.getByText(`${ownerEmail} added you to Added Co.`)).toBeVisible()
  await expectAccessible(them, 'gallery, added to an organization')

  // With the keyboard: Leave asks first, and Cancel puts focus back on Leave
  await notice.getByRole('button', { name: 'Leave Added Co' }).press('Enter')
  await expect(notice.getByRole('button', { name: 'Leave Added Co' })).toBeFocused()
  await expect(notice.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expectAccessible(them, 'gallery, leaving an organization you were added to')
  await notice.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(notice.getByRole('button', { name: 'Leave Added Co' })).toBeFocused()
  await notice.getByRole('button', { name: 'Dismiss the notice about Added Co' }).press('Enter')
  await expect(notice).toHaveCount(0)
  await expect(them.getByRole('heading', { level: 1, name: 'Pages' })).toBeFocused()
  await context.close()
})
