import { expect, test } from '@playwright/test'

test('landing page renders and the pricing toggle switches plans', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your agent writes the page. You send the link.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Self-host for free' })).toHaveAttribute('href', '/self-hosting')

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
  await expect(pricing.getByRole('link', { name: 'Read the install guide' })).toHaveAttribute('href', '/self-hosting')
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

test('the install guide renders', async ({ page }) => {
  await page.goto('/self-hosting')
  await expect(page.getByRole('heading', { level: 1, name: 'Self-host The Artifact' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy the start command' })).toBeVisible()
  await expect(page.locator('.command', { has: page.getByRole('button', { name: 'Copy the start command' }) })).toContainText('docker compose -f docker-compose.selfhost.yml up -d')
})

test('unknown paths show the 404 page', async ({ page }) => {
  await page.goto('/definitely/not/here')
  await expect(page.getByRole('heading', { name: "This page doesn't exist" })).toBeVisible()
})
