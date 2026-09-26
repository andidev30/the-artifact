import { expect, test } from '@playwright/test'

test('landing page renders and the pricing toggle switches plans', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your agent writes the page. You send the link.' })).toBeVisible()

  const pricing = page.locator('#pricing')
  await expect(pricing.getByRole('heading', { name: 'Pricing' })).toBeVisible()

  const cloud = pricing.getByRole('radio', { name: 'Cloud' })
  const selfHosted = pricing.getByRole('radio', { name: 'Self-hosted' })
  await expect(cloud).toHaveAttribute('aria-checked', 'true')
  await expect(pricing.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Organization', exact: true })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Enterprise', exact: true })).toBeVisible()

  await selfHosted.click()
  await expect(selfHosted).toHaveAttribute('aria-checked', 'true')
  await expect(cloud).toHaveAttribute('aria-checked', 'false')
  await expect(pricing.getByRole('heading', { name: 'Self-hosted Team' })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Self-hosted Enterprise' })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Personal', exact: true })).toHaveCount(0)

  await cloud.click()
  await expect(pricing.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible()
  await expect(pricing.getByRole('heading', { name: 'Self-hosted Team' })).toHaveCount(0)
})

test('unknown paths show the 404 page', async ({ page }) => {
  await page.goto('/definitely/not/here')
  await expect(page.getByRole('heading', { name: "This page doesn't exist" })).toBeVisible()
})
