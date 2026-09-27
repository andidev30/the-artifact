import { expect, test } from '@playwright/test'
import { latestMail, uniqueEmail } from './helpers'

test('landing page renders and the pricing toggle switches plans', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your agent writes the page. You send the link.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get started free' }).first()).toHaveAttribute('href', '/signup')
  await expect(page.getByRole('link', { name: 'Self-host for free' })).toHaveAttribute('href', '/docs/self-hosting')

  const pricing = page.locator('#pricing')
  await expect(pricing.getByRole('heading', { name: 'Pricing' })).toBeVisible()

  // The cloud comes first and is selected: Personal is available, the paid plans are not yet
  const radios = pricing.getByRole('radio')
  await expect(radios.first()).toHaveText('Cloud')
  const selfHosted = pricing.getByRole('radio', { name: 'Self-hosted' })
  const cloud = pricing.getByRole('radio', { name: 'Cloud' })
  await expect(cloud).toHaveAttribute('aria-checked', 'true')
  await expect(pricing.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await expect(pricing.getByRole('link', { name: 'Get started free' })).toHaveAttribute('href', '/signup')
  for (const name of ['Organization', 'Enterprise']) {
    await expect(pricing.getByRole('heading', { name: `${name} Coming soon` })).toBeVisible()
  }
  await expect(
    pricing
      .locator('.plan')
      .filter({ has: page.getByRole('heading', { name: 'Organization Coming soon' }) })
      .locator('.plan-price'),
  ).toHaveText('$4per member / month')
  await expect(pricing.locator('.plan[data-coming-soon]')).toHaveCount(2)
  await expect(pricing.locator('.plans').getByRole('link')).toHaveCount(1)

  await selfHosted.click()
  await expect(selfHosted).toHaveAttribute('aria-checked', 'true')
  await expect(pricing.getByRole('heading', { name: 'Self-hosted', exact: true })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Self-hosted Enterprise' })).toBeVisible()
  await expect(pricing.getByRole('link', { name: 'Read the install guide' })).toHaveAttribute('href', '/docs/self-hosting')
  await expect(pricing.getByRole('link', { name: 'Contact sales' })).toBeVisible()
})

test('the Enterprise button leads to a contact form that emails sales', async ({ page }) => {
  await page.goto('/#pricing')
  // Cloud Enterprise isn't available yet; the self-hosted one is
  await page.locator('#pricing').getByRole('radio', { name: 'Self-hosted' }).click()
  await page.locator('#pricing').getByRole('link', { name: 'Contact sales' }).click()
  await expect(page).toHaveURL(/\/contact-sales\?topic=self-hosted-enterprise$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Bring The Artifact to your whole company.' })).toBeVisible()

  const email = uniqueEmail('sales')
  const company = `Acme ${Date.now().toString(36)}`
  await page.getByLabel('Name', { exact: true }).fill('Dana Lee')
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Company', { exact: true }).fill(company)
  await page.getByLabel('Team size').selectOption('51-200')
  await page.getByLabel('What would you like to talk about?').fill('We want to run it on our own servers with SAML sign-in.')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByRole('heading', { name: 'Thanks, we got your message' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(email)

  // Without SALES_EMAIL set, inquiries go to the sender address
  const text = await latestMail(page.request, 'e2e@example.com', new RegExp(`Sales inquiry from Dana Lee at ${company}`))
  expect(text).toContain(`Email: ${email}`)
  expect(text).toContain('Interested in: Self-hosted Enterprise')
  expect(text).toContain('SAML sign-in')
})

test('docs render, link between pages and redirect the old guide address', async ({ page }) => {
  await page.goto('/self-hosting')
  await expect(page).toHaveURL(/\/docs\/self-hosting$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Self-hosting' })).toBeVisible()
  await expect(page.locator('.doc-code').first()).toContainText('git clone')

  // Examples use this install's own address
  await page.getByRole('link', { name: 'Connect your agent', exact: true }).first().click()
  await expect(page).toHaveURL(/\/docs\/connect-your-agent$/)
  await expect(page.locator('.doc')).toContainText('claude mcp add --transport http --scope user the-artifact http://localhost:5177/mcp')

  await page.getByRole('link', { name: /Next\s*Publishing pages/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Publishing pages' })).toBeVisible()
})

test('unknown paths show the 404 page', async ({ page }) => {
  await page.goto('/definitely/not/here')
  await expect(page.getByRole('heading', { name: "This page doesn't exist" })).toBeVisible()
})
