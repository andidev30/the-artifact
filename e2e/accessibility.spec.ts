import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { grantInstanceAdmin } from '../apps/api/test/e2e-db.ts'
import { expectAccessible } from './axe'
import { connectAgent, latestMail, publishViaMcp, signInLink, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><title>Plan</title><h1>Plan</h1>'

async function createOrganization(page: Page, name: string) {
  const res = await page.request.post('/api/organizations', { data: { name, slug: `e2e-${randomBytes(4).toString('hex')}` } })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; slug: string }
}

test('signed-out screens', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible()
  await expectAccessible(page, 'landing and pricing')

  await page.goto('/contact-sales')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'contact sales')

  await page.goto('/docs/introduction')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'docs')

  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'log in')

  await page.goto('/signup')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'sign up')
  await page.getByLabel('Email').fill(uniqueEmail('a11y-inbox'))
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await expectAccessible(page, 'check your inbox')

  await page.goto('/this-does-not-exist')
  await expect(page.getByRole('heading', { name: 'This page doesn’t exist' }).or(page.getByRole('heading', { name: "This page doesn't exist" }))).toBeVisible()
  await expectAccessible(page, 'not found')

  await page.goto('/a/doesnotexist')
  await expect(page.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  await expectAccessible(page, 'page not available, signed out')

  await page.goto('/invite/not-a-real-token')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'invalid invitation')
})

// The e2e servers send email, so the screens of a server without it are shown by answering
// /api/config the way such a server would. Nothing is submitted.
test('sign-in and first-run setup on a server without email', async ({ page }) => {
  let config = { selfHosted: true, googleSignIn: false, emailSignIn: false, needsSetup: true, passwordSignUp: false }
  await page.route('**/api/config', (route) => route.fulfill({ json: config }))

  await page.goto('/signup')
  await expect(page.getByLabel('Confirm password')).toBeVisible()
  await expectAccessible(page, 'first-run setup')

  config = { ...config, needsSetup: false }
  await page.goto('/login')
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expectAccessible(page, 'log in with a password')

  await page.goto('/signup')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'sign up, closed')

  config = { ...config, passwordSignUp: true }
  await page.goto('/signup')
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expectAccessible(page, 'sign up with a password')
})

test('sign-in link, onboarding and an empty gallery', async ({ page }) => {
  const email = uniqueEmail('a11y-onboarding')
  await page.goto('/signup')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await page.goto(await signInLink(page.request, email))
  await expect(page.getByRole('button', { name: `Continue as ${email}` })).toBeVisible()
  await expectAccessible(page, 'confirm sign-in')
  await page.getByRole('button', { name: `Continue as ${email}` }).click()

  await expect(page).toHaveURL(/\/onboarding/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'onboarding, workspace choice')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expectAccessible(page, 'onboarding, connect your agent')
  await page.getByRole('link', { name: 'Go to your pages' }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText('No pages yet.')).toBeVisible()
  await expectAccessible(page, 'empty gallery')

  await page.getByRole('button', { name: /^Account:/ }).click()
  await expect(page.getByRole('link', { name: 'Account settings' })).toBeVisible()
  await expectAccessible(page, 'account menu')
  await page.keyboard.press('Escape')

  await page.goto('/organizations/new')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectAccessible(page, 'new organization')

  await page.goto('/a/doesnotexist')
  await expect(page.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  await expectAccessible(page, 'page not available, signed in')
})

test('gallery with pages and folders, its menus and dialogs', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-gallery'))
  const org = await createOrganization(page, 'Access Co')
  await page.evaluate((id) => localStorage.setItem('the-artifact.workspace', id), org.id)
  const token = await connectAgent(page, org.id)
  await publishViaMcp(page.request, token, { title: 'Roadmap draft', html: HTML })
  await publishViaMcp(page.request, token, { title: 'Roadmap Q3', html: HTML, folder: 'Plans' })
  await publishViaMcp(page.request, token, { title: 'Launch notes', html: HTML, visibility: 'link' })
  await page.reload()

  const gallery = page.getByRole('list', { name: 'Pages in Access Co' })
  await expect(gallery.locator('.page-card')).toHaveCount(3)
  await expectAccessible(page, 'gallery')

  await page.getByRole('button', { name: /^Workspace:/ }).click()
  await expect(page.getByRole('button', { name: /Personal/ })).toBeVisible()
  await expectAccessible(page, 'workspace switcher')
  await page.keyboard.press('Escape')

  const folders = page.getByRole('navigation', { name: 'Folders' })
  await folders.getByRole('button', { name: /Plans/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Plans' })).toBeVisible()
  await expectAccessible(page, 'gallery, one folder')
  await folders.getByRole('button', { name: /All pages/ }).click()

  await page.getByRole('searchbox', { name: 'Search pages by title' }).fill('nothing like this')
  await expect(page.getByText('No pages match “nothing like this”.')).toBeVisible()
  await expectAccessible(page, 'gallery, no search results')
  await page.getByRole('button', { name: 'Clear search' }).click()

  await page.getByRole('tab', { name: 'Shared with you' }).click()
  await expect(page.getByText('Nothing has been shared with you yet.')).toBeVisible()
  await expectAccessible(page, 'gallery, shared with you')
  await page.getByRole('tab', { name: 'Access Co' }).click()

  await page.getByRole('button', { name: 'More actions for Roadmap draft' }).click()
  await expect(page.getByRole('menuitem', { name: 'Move to folder' })).toBeVisible()
  await expectAccessible(page, 'page menu')
  await page.getByRole('menuitem', { name: 'Move to folder' }).click()
  await expect(page.getByRole('dialog', { name: 'Move “Roadmap draft”' })).toBeVisible()
  await expectAccessible(page, 'move to folder dialog')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'More actions for Roadmap draft' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(page.getByRole('dialog', { name: 'Rename page' })).toBeVisible()
  await expectAccessible(page, 'rename dialog')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'More actions for Roadmap draft' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete “Roadmap draft”?' })).toBeVisible()
  await expectAccessible(page, 'delete dialog')
  await page.keyboard.press('Escape')

  await folders.getByRole('button', { name: 'New folder' }).click()
  await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible()
  await expectAccessible(page, 'new folder dialog')
  await page.keyboard.press('Escape')
})

test('viewer with its history and comments panels, and the share dialog', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-viewer'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Launch plan', html: HTML, visibility: 'link' })
  await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<h1>Plan, second draft</h1>', artifact_id: slug })

  await page.goto(`/a/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible()
  await expectAccessible(page, 'viewer')

  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('complementary', { name: 'Version history' })
  await expect(history.getByRole('button', { name: /Version 1/ })).toBeVisible()
  await expectAccessible(page, 'history panel')
  await history.getByRole('button', { name: /Version 1/ }).click()
  await expect(page.getByRole('region', { name: 'Older version' })).toBeVisible()
  await expectAccessible(page, 'viewing an older version')
  await page.getByRole('button', { name: 'Back to latest' }).click()

  await page.getByRole('button', { name: 'Comments' }).click()
  const comments = page.getByRole('complementary', { name: 'Comments' })
  await expect(comments.getByText('No comments yet.')).toBeVisible()
  await comments.getByLabel('New comment').fill('Needs a legend')
  await comments.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(comments.locator('.comment-body')).toHaveText('Needs a legend')
  await expectAccessible(page, 'comments panel')

  await page.getByRole('button', { name: 'Share' }).click()
  const share = page.getByRole('dialog', { name: 'Share “Launch plan”' })
  await expect(share.getByRole('heading', { name: 'Embed' })).toBeVisible()
  await share.getByLabel('Add people by email').fill(uniqueEmail('a11y-shared'))
  await expect(share.getByLabel('Notify people by email')).toBeVisible()
  await expectAccessible(page, 'share dialog')
  await share.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(share.getByText(/^Shared with/)).toBeVisible()
  await expectAccessible(page, 'share dialog, after sharing')
  await share.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible()
  await expectAccessible(page, 'viewer menu')
})

test('account and organization settings', async ({ page, browser }) => {
  const email = uniqueEmail('a11y-settings')
  await signUpPersonal(page, email)
  await connectAgent(page)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible()
  await expect(page.locator('section#sessions').getByRole('listitem').first()).toBeVisible()
  await expectAccessible(page, 'account settings')

  const tokens = page.locator('section#tokens')
  await tokens.getByLabel('Name').fill('Nightly report')
  await tokens.getByRole('button', { name: 'Create token' }).click()
  await expect(tokens.locator('.settings-token-new')).toBeVisible()
  await expectAccessible(page, 'account settings, new access token')

  const security = page.locator('section#security')
  await security.getByRole('button', { name: 'Set up' }).click()
  await expect(security.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  await expectAccessible(page, 'account settings, authenticator setup')

  const org = await createOrganization(page, 'Settings Co')
  const guest = uniqueEmail('a11y-invited')
  expect((await page.request.post(`/api/organizations/${org.id}/invitations`, { data: { email: guest, role: 'member' } })).status()).toBe(201)
  await page.goto(`/organizations/${org.slug}/settings`)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings Co settings' })).toBeVisible()
  await expect(page.getByText(guest)).toBeVisible()
  await expect(page.getByLabel('Require two-factor sign-in')).toBeVisible()
  await expectAccessible(page, 'organization settings')

  // The invitation, as the person invited sees it before and after signing in
  const link = (await latestMail(page.request, guest, /invit/i)).match(/https?:\/\/\S+\/invite\/\S+/)?.[0]
  expect(link, 'invitation link in email').toBeTruthy()
  const other = await browser.newContext()
  const them = await other.newPage()
  await them.goto(link!)
  await expect(them.getByRole('heading', { level: 1, name: 'Join Settings Co' })).toBeVisible()
  await expectAccessible(them, 'invitation, signed out')
  await other.close()
})

test('server admin', async ({ page }) => {
  const email = uniqueEmail('a11y-admin')
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Server admin', exact: true })).toBeVisible()
  await expect(page.locator('#people').getByText(/Showing/)).toBeVisible()
  await expectAccessible(page, 'server admin')

  await page.getByLabel('Search people').fill(email)
  const people = page.locator('#people')
  await expect(people.getByText('Showing 1 of 1 person')).toBeVisible()
  await people.getByRole('button', { name: 'Manage' }).click()
  await expectAccessible(page, 'server admin, managing someone')

  // Hosted only; e2e/self-hosted/license.spec.ts checks the License section of a self-hosted install
  await page.goto('/admin#license-keys')
  await expect(page.locator('#license-keys').getByRole('note')).toBeVisible()
  await expectAccessible(page, 'server admin, license keys', { include: '#license-keys' })
})

test('agent consent page', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-consent'))
  const redirectUri = 'http://127.0.0.1:43999/callback'
  const client = await (await page.request.post('/oauth/register', { data: { client_name: 'e2e-agent', redirect_uris: [redirectUri] } })).json()
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
  const authorize = await page.request.get('/oauth/authorize', {
    params: { response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' },
    maxRedirects: 0,
  })
  await page.goto(new URL(authorize.headers().location).pathname + new URL(authorize.headers().location).search)
  await expect(page.getByRole('heading', { level: 1, name: 'Connect e2e-agent' })).toBeVisible()
  await expectAccessible(page, 'consent')
})
