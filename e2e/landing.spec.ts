import { expect, test } from '@playwright/test'

test('landing page renders and the pricing toggle switches plans', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your agent writes the page. You send the link.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Self-host for free' })).toHaveAttribute('href', '/docs/self-hosting')

  const pricing = page.locator('#pricing')
  await expect(pricing.getByRole('heading', { name: 'Pricing' })).toBeVisible()

  // Self-hosted is what's available today, so it comes first and is selected
  const radios = pricing.getByRole('radio')
  await expect(radios.first()).toHaveText('Self-hosted')
  const selfHosted = pricing.getByRole('radio', { name: 'Self-hosted' })
  const cloud = pricing.getByRole('radio', { name: 'Cloud' })
  await expect(selfHosted).toHaveAttribute('aria-checked', 'true')
  await expect(pricing.getByRole('heading', { name: 'Self-hosted', exact: true })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Self-hosted Enterprise' })).toBeVisible()
  await expect(pricing.getByRole('link', { name: 'Read the install guide' })).toHaveAttribute('href', '/docs/self-hosting')
  await expect(pricing.getByRole('link', { name: 'Contact sales' })).toBeVisible()

  // Cloud plans are shown but not available yet
  await cloud.click()
  await expect(cloud).toHaveAttribute('aria-checked', 'true')
  for (const name of ['Personal', 'Organization', 'Enterprise']) {
    await expect(pricing.getByRole('heading', { name: `${name} Coming soon` })).toBeVisible()
  }
  await expect(pricing.locator('.plan[data-coming-soon]')).toHaveCount(3)
  await expect(pricing.locator('.plans').getByRole('link')).toHaveCount(0)

  await selfHosted.click()
  await expect(pricing.getByRole('heading', { name: 'Self-hosted', exact: true })).toBeVisible()
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
