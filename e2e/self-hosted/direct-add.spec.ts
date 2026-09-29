import { randomBytes } from 'node:crypto'
import { type Browser, expect, type Page, test } from '@playwright/test'
import { fromApp, latestMail, openSignInLink, signInLink, uniqueEmail } from '../helpers'

// Runs after first-account.spec.ts, so every account here starts in its personal workspace

async function signUp(page: Page, email: string) {
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/app$/)
}

async function signedIn(browser: Browser, email: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signUp(page, email)
  return { context, page }
}

async function createOrganization(page: Page, name: string) {
  const slug = `e2e-${randomBytes(4).toString('hex')}`
  const res = await page.request.post('/api/organizations', { headers: fromApp(page), data: { name, slug } })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; slug: string }
}

test('an owner adds someone who already has an account, who can open the organization or leave it', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('sh-add-owner')
  const alexEmail = uniqueEmail('sh-add-alex')
  const samEmail = uniqueEmail('sh-add-sam')
  await signUp(page, ownerEmail)
  const org = await createOrganization(page, 'Direct Co')
  const alex = await signedIn(browser, alexEmail)
  const sam = await signedIn(browser, samEmail)

  await page.goto(`/organizations/${org.slug}/settings`)
  await expect(page.getByText('People who already have an account here are added right away.', { exact: false })).toBeVisible()
  await page.locator('#invite-email').fill(alexEmail)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(`Added ${alexEmail} as member.`)).toBeVisible()
  await expect(page.locator('.settings-who').getByText(alexEmail)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pending invitations' })).toHaveCount(0)
  expect(await latestMail(page.request, alexEmail, /added you to Direct Co/)).toContain('Direct Co')

  // Alex is a member at once, and hears about it once
  await alex.page.goto('/app')
  const notice = alex.page.getByRole('region', { name: 'Organizations you were added to' })
  await expect(notice.getByText(`${ownerEmail} added you to Direct Co.`)).toBeVisible()
  await notice.getByRole('button', { name: 'Open Direct Co' }).click()
  await expect(alex.page.getByText('Everything published to Direct Co. Your role: Member.')).toBeVisible()
  await expect(notice).toHaveCount(0)
  await alex.page.reload()
  await expect(alex.page.getByText('Everything published to Direct Co. Your role: Member.')).toBeVisible()
  await expect(notice).toHaveCount(0)

  // Sam would rather not be in it
  await page.locator('#invite-email').fill(samEmail)
  await page.locator('#invite-role').selectOption('admin')
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(`Added ${samEmail} as admin.`)).toBeVisible()

  await sam.page.goto('/app')
  const samNotice = sam.page.getByRole('region', { name: 'Organizations you were added to' })
  await samNotice.getByRole('button', { name: 'Leave Direct Co' }).click()
  await expect(samNotice.getByText('Leave Direct Co?', { exact: false })).toBeVisible()
  await samNotice.getByRole('button', { name: 'Leave Direct Co' }).click()
  await expect(samNotice).toHaveCount(0)
  const me = (await (await sam.page.request.get('/api/me')).json()) as { organizations: unknown[] }
  expect(me.organizations).toEqual([])

  await alex.context.close()
  await sam.context.close()
})
