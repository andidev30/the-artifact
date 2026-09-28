import { expect, type Page, test } from '@playwright/test'
import { createSelfHostedAccount } from '../../apps/api/test/e2e-db.ts'
import { openSignInLink, signInLink, uniqueEmail } from '../helpers'

// Runs after first-account.spec.ts (see playwright.config.ts), so every account here comes after the first

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
}

// Every address the tab shows, including client-side route changes
function urlsVisited(page: Page) {
  const urls: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(new URL(frame.url()).pathname)
  })
  return urls
}

async function expectPersonalWorkspace(page: Page) {
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toBeVisible()
  await expect(page.getByText('Everything your agents publish for you.')).toBeVisible()
  expect(((await (await page.request.get('/api/me')).json()) as { onboarded: boolean }).onboarded).toBe(true)
}

test('someone who signs up after the first account starts in their personal workspace', async ({ page }) => {
  const email = uniqueEmail('sh-later')
  const visited = urlsVisited(page)
  await page.goto('/signup')
  await expect(page.getByText('Create an account on this server.')).toBeVisible()
  // The hosted service's terms are not this server's
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveCount(0)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)

  await expectPersonalWorkspace(page)
  // No stop at /onboarding on the way: the account was made onboarded
  expect(visited).not.toContain('/onboarding')

  await page.getByRole('button', { name: /^Account:/ }).click()
  await expect(page.getByRole('link', { name: 'Server admin' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Unlike the hosted service, a self-hosted server lets anyone create an organization
  await page.getByRole('button', { name: /^Workspace:/ }).click()
  await page.getByRole('link', { name: 'Create an organization' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Create an organization' })).toBeVisible()
  await expect(page.getByLabel('Organization name')).toBeVisible()

  await page.goto('/onboarding')
  await expect(page).toHaveURL(/\/app$/)
})

test('an account made before new accounts started onboarded is finished on its first visit', async ({ page }) => {
  const email = uniqueEmail('sh-legacy')
  await createSelfHostedAccount(email, { isAdmin: false })

  const visited = urlsVisited(page)
  await signIn(page, email)
  await expectPersonalWorkspace(page)
  // /app sent it to /onboarding, which finished it without asking anything and came back
  expect(visited).toContain('/onboarding')
  await expect(page.getByRole('radio')).toHaveCount(0)
})

test('an admin who has not set the server up yet can skip naming an organization', async ({ page }) => {
  // The state the first account is in until it finishes onboarding; the real first account named one
  const email = uniqueEmail('sh-skip')
  await createSelfHostedAccount(email, { isAdmin: true })

  await signIn(page, email)
  await expect(page).toHaveURL(/\/onboarding/)
  await expect(page.getByRole('heading', { name: /Name your organization/ })).toBeVisible()
  await page.getByRole('button', { name: 'Skip, just me for now' }).click()

  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expect(page.getByText('Your workspace is ready.')).toBeVisible()
  await page.getByRole('link', { name: 'Go to your pages' }).click()
  await expectPersonalWorkspace(page)
})

test('the hosted service legal pages and Vercel analytics are not on a self-hosted install', async ({ page }) => {
  const vercel: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/_vercel/')) vercel.push(req.url())
  })
  for (const doc of ['terms', 'privacy', 'subprocessors', 'dpa']) {
    await page.goto(`/legal/${doc}`)
    await expect(page.getByRole('heading', { name: /This page doesn.t exist/ })).toBeVisible()
  }
  expect(vercel).toEqual([])
})
