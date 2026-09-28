import { expect, type Page, test } from '@playwright/test'
import { createSelfHostedAccount } from '../../apps/api/test/e2e-db.ts'
import { expectAccessible } from '../axe'
import { openSignInLink, signInLink, uniqueEmail } from '../helpers'

// Without a license, which e2e can't make (see license.spec.ts): the single sign-on and SCIM sections
// say one is needed, the sign-in page has no SSO button, and SCIM and SAML refuse requests. Signing in
// with SAML and provisioning over SCIM are covered by apps/api/test/integration/saml.test.ts and
// scim.test.ts; the licensed screens by the single sign-on tests in e2e/accessibility.spec.ts.

async function signInAsAdmin(page: Page) {
  const email = uniqueEmail('sh-sso')
  await createSelfHostedAccount(email, { isAdmin: true, onboarded: true })
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/app$/)
}

test('SAML and SCIM need a license, and the sections say so', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Continue with (?!Google)/ })).toHaveCount(0)

  const scim = await page.request.get('/scim/v2/Users', { headers: { authorization: 'Bearer scim_not-a-token' } })
  expect(scim.status()).toBe(401)
  expect(await scim.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' })
  expect((await page.request.get('/api/auth/sso/saml/metadata')).status()).toBe(404)

  await signInAsAdmin(page)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Server admin', exact: true })).toBeVisible()

  // The rail reaches the section by keyboard
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Provisioning' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#scim$/)

  await expect(page.locator('#sso')).toContainText('Single sign-on needs an Enterprise license')
  const provisioning = page.locator('#scim')
  await expect(provisioning).toContainText('SCIM needs an Enterprise license')
  await expect(provisioning.getByRole('button', { name: 'Make token' })).toHaveCount(0)
  await expectAccessible(page, 'server admin, SCIM without a license', { include: '#scim' })
})
