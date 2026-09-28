import { expect, test } from '@playwright/test'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

test('an open page shows a new version as soon as it is published', async ({ page }) => {
  test.setTimeout(30_000)
  await signUpPersonal(page, uniqueEmail('live'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Live', html: '<!doctype html><h1>First draft</h1>' })

  await page.goto(`/a/${slug}`)
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'First draft' })).toBeVisible()
  const share = page.getByRole('button', { name: 'Share' })
  await share.focus()

  await publishViaMcp(page.request, token, { title: 'Live', html: '<!doctype html><h1>Second draft</h1>', artifact_id: slug })
  await expect(frame.getByRole('heading', { name: 'Second draft' })).toBeVisible({ timeout: 10_000 })
  // Signed-in viewers load it under ~comments/ for the comment helper
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('src', new RegExp(`^/api/artifacts/${slug}/v/2/`))
  await expect(page.getByRole('status').filter({ hasText: 'Updated to version 2.' })).toBeAttached()
  await expect(page.getByText('Updated to version 2', { exact: true })).toBeVisible()
  await expect(share).toBeFocused()

  // Someone looking at an older version keeps it
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: /Version 1/ }).click()
  await expect(page.getByText('Viewing version 1')).toBeVisible()
  await publishViaMcp(page.request, token, { title: 'Live', html: '<!doctype html><h1>Third draft</h1>', artifact_id: slug })
  await page.waitForTimeout(4_000)
  await expect(frame.getByRole('heading', { name: 'First draft' })).toBeVisible()
})
