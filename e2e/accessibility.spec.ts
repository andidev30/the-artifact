import { createHash, randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { createHostedOrganization, grantInstanceAdmin } from '../apps/api/test/e2e-db.ts'
import { expectAccessible } from './axe'
import { fromApp, connectAgent, latestMail, licensedSso, mockAuditLog, mockRetention, publishViaMcp, signInLink, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><title>Plan</title><h1>Plan</h1>'

// Written to the database: the hosted service doesn't create new organizations yet
function createOrganization(ownerEmail: string, name: string) {
  return createHostedOrganization(ownerEmail, name, `e2e-${randomBytes(4).toString('hex')}`)
}

// Its own test: with the other signed-out screens it ran past the time limit on CI runners
test('legal pages', async ({ page }) => {
  for (const [doc, title] of [
    ['terms', 'Terms of Service'],
    ['privacy', 'Privacy Policy'],
    ['subprocessors', 'Sub-processors'],
    ['dpa', 'Data Processing Addendum'],
  ]) {
    await page.goto(`/legal/${doc}`)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expectAccessible(page, title)
  }
})

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
  await expectAccessible(page, 'onboarding, welcome')
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

  // The hosted service says new organizations are coming soon instead of offering the form
  await page.getByRole('button', { name: /^Workspace:/ }).click()
  await expect(page.getByText('New organizations are coming soon.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create an organization' })).toHaveCount(0)
  await expectAccessible(page, 'workspace switcher, personal only')
  await page.keyboard.press('Escape')

  await page.goto('/organizations/new')
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations are coming soon' })).toBeVisible()
  await expect(page.getByLabel('Organization name')).toHaveCount(0)
  await expectAccessible(page, 'new organization, coming soon')

  await page.goto('/a/doesnotexist')
  await expect(page.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  await expectAccessible(page, 'page not available, signed in')
})

test('gallery with pages and folders, its menus and dialogs', async ({ page }) => {
  const email = uniqueEmail('a11y-gallery')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Access Co')
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
  // The old list stays dimmed until the folder's pages arrive; axe would measure the dimmed colours
  await expect(page.locator('.page-card')).toHaveCount(1)
  await expect(page.locator('.gallery[data-stale]')).toHaveCount(0)
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

// Its own test, to stay inside the per-test time limit on CI
test('comparing two versions', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-compare'))
  const token = await connectAgent(page)
  const files = (css: string) => [{ path: 'site.css', content: css }]
  const slug = await publishViaMcp(page.request, token, { title: 'Launch plan', html: HTML, files: files('h1 { color: navy }\n') })
  await publishViaMcp(page.request, token, {
    title: 'Launch plan',
    html: '<h1>Plan, second draft</h1>',
    artifact_id: slug,
    files: files('h1 { color: teal }\n'),
  })

  await page.goto(`/a/${slug}`)
  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('complementary', { name: 'Version history' })
  await history.getByRole('checkbox', { name: 'Compare version 1' }).check()
  await history.getByRole('checkbox', { name: 'Compare version 2' }).check()
  await expectAccessible(page, 'history panel with two versions picked')
  await history.getByRole('button', { name: 'Compare' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Compare versions' })).toBeVisible()
  await expect(page.frameLocator('iframe[title="Launch plan, version 2"]').getByRole('heading', { name: 'Plan, second draft' })).toBeVisible()
  await expectAccessible(page, 'versions side by side')

  await page.getByRole('button', { name: 'Changes' }).click()
  await expect(page.getByRole('region', { name: 'Changed: site.css' })).toBeVisible()
  await expectAccessible(page, 'changes between versions')
})

test('viewer with its history, views and comments panels, and the share dialog', async ({ page, browser }) => {
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

  await page.getByRole('button', { name: /^Views/ }).click()
  const views = page.getByRole('complementary', { name: 'Views' })
  await expect(views.getByRole('heading', { name: 'By version' })).toBeVisible()
  await expectAccessible(page, 'views panel')
  await views.getByRole('button', { name: 'Close views' }).click()

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
  await expect(share.getByText('The link never expires.')).toBeVisible()
  await share.getByRole('radio', { name: 'On a date' }).check()
  await share.getByRole('button', { name: 'Save link settings' }).click()
  await expect(share.getByText('Choose the last day the link works, or choose Never.')).toBeVisible()
  await expect(share.getByLabel('Last day the link works')).toHaveAttribute('aria-describedby', /share-link-error/)
  await expectAccessible(page, 'share dialog, link expiry error')
  await share.getByRole('radio', { name: 'Never' }).check()
  await share.getByLabel('Link password', { exact: true }).fill('short')
  await share.getByRole('button', { name: 'Save link settings' }).click()
  await expect(share.getByText('Use at least 8 characters for the password.')).toBeVisible()
  await expectAccessible(page, 'share dialog, link password error')
  await share.getByLabel('Link password', { exact: true }).fill('open sesame')
  await share.getByRole('button', { name: 'Save link settings' }).click()
  await expect(share.getByText('Link settings saved.')).toBeVisible()
  await expectAccessible(page, 'share dialog, link with a password')
  await share.getByRole('button', { name: 'Reset link' }).click()
  await expect(share.getByRole('button', { name: 'Make a new link' })).toBeVisible()
  await expectAccessible(page, 'share dialog, new link confirmation')
  await share.getByRole('button', { name: 'Cancel' }).click()
  await share.getByRole('button', { name: 'Done' }).click()

  const visitor = await browser.newContext()
  const visitorPage = await visitor.newPage()
  await visitorPage.goto(`/a/${slug}`)
  await expect(visitorPage.getByRole('heading', { name: 'This page needs a password' })).toBeVisible()
  await expectAccessible(visitorPage, 'page password')
  await visitorPage.getByLabel('Password', { exact: true }).fill('not the password')
  await visitorPage.keyboard.press('Enter')
  await expect(visitorPage.getByRole('alert')).toHaveText('That password is wrong.')
  await expectAccessible(visitorPage, 'page password, wrong')
  await visitor.close()

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

  const org = await createOrganization(email, 'Settings Co')
  const guest = uniqueEmail('a11y-invited')
  expect(
    (await page.request.post(`/api/organizations/${org.id}/invitations`, { headers: fromApp(page), data: { email: guest, role: 'member' } })).status(),
  ).toBe(201)
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

test('data export in account and organization settings', async ({ page }) => {
  const email = uniqueEmail('a11y-export')
  await signUpPersonal(page, email)

  await page.goto('/settings#export')
  const section = page.locator('section#export')
  await expect(section.getByRole('heading', { name: 'Export your data' })).toBeVisible()
  await expectAccessible(page, 'account settings, data export')
  // Keyboard only: into the choice of versions, to the second one, then the button
  await section.getByLabel(/Only the current version/).focus()
  await page.keyboard.press('ArrowDown')
  await expect(section.getByLabel(/Every version/)).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(section.getByRole('button', { name: 'Export data' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(section.getByText('Your export is ready.')).toBeVisible({ timeout: 20_000 })
  await expect(section.getByRole('link', { name: 'Download zip' })).toBeVisible()
  await expectAccessible(page, 'account settings, data export ready')

  const org = await createOrganization(email, 'Export Co')
  await page.goto(`/organizations/${org.slug}/settings#export`)
  await expect(page.locator('section#export').getByRole('heading', { name: 'Export organization data' })).toBeVisible()
  await expectAccessible(page, 'organization settings, data export')
})

test('version retention in organization settings, with and without a license', async ({ page }) => {
  const email = uniqueEmail('a11y-retention')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Retention Co')
  await mockRetention(page, { keepDays: null, keepVersions: null, license: 'active' })
  await page.goto(`/organizations/${org.slug}/settings#retention`)
  const section = page.locator('section#retention')
  await expect(section.getByLabel('Keep older versions for')).toBeEnabled()
  await section.getByLabel('Keep older versions for').selectOption({ label: '90 days' })
  await section.getByLabel('Also keep at most a number of versions per page').check()
  await expect(section.getByText('About 12 versions on 3 pages would be removed.')).toBeVisible()
  await expect(section.getByText('Removed versions can’t be restored.')).toBeVisible()
  await expectAccessible(page, 'organization settings, version retention')
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(section.getByRole('button', { name: 'Save and remove 12 versions' })).toBeFocused()
  await expectAccessible(page, 'organization settings, version retention confirm')

  await page.unrouteAll()
  await mockRetention(page, { keepDays: 90, keepVersions: null, license: 'expired' })
  await page.reload()
  await expect(section.getByText(/kept but not applied/)).toBeVisible()
  await expect(section.getByLabel('Keep older versions for')).toBeDisabled()
  await expectAccessible(page, 'organization settings, version retention without a license')
})

test('organization audit log', async ({ page }) => {
  const email = uniqueEmail('a11y-audit')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Audit Co')
  await mockAuditLog(page)

  await page.goto(`/organizations/${org.slug}/settings#audit`)
  const audit = page.locator('section#audit')
  await expect(audit.getByRole('heading', { name: 'Audit log' })).toBeVisible()
  await expect(audit.getByRole('list', { name: 'Audit log events' }).getByRole('listitem')).toHaveCount(50)
  await expectAccessible(page, 'organization audit log', { include: 'section#audit' })

  await audit.getByLabel('Action').selectOption('member.role_changed')
  await audit.getByLabel('From').fill('2026-09-30')
  await audit.getByLabel('To').fill('2026-09-01')
  await audit.getByRole('button', { name: 'Filter' }).click()
  await expect(audit.getByText('Choose an end date on or after the start date.')).toBeVisible()
  await expectAccessible(page, 'organization audit log, date error', { include: 'section#audit' })

  await audit.getByLabel('To').fill('')
  await audit.getByLabel('Action').selectOption('member.invited')
  await audit.getByRole('button', { name: 'Filter' }).click()
  await expect(audit.getByText('No events match these filters.')).toBeVisible()
  await expectAccessible(page, 'organization audit log, no matches', { include: 'section#audit' })
})

test('organization settings without an Enterprise license leave the audit log out', async ({ page }) => {
  const email = uniqueEmail('a11y-audit-unlicensed')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Unlicensed Co')
  const asked = await mockAuditLog(page, { licensed: false })
  await page.goto(`/organizations/${org.slug}/settings`)
  await expect(page.getByRole('heading', { level: 1, name: 'Unlicensed Co settings' })).toBeVisible()
  await expect.poll(() => asked.length).toBeGreaterThan(0)
  await expect(page.locator('section#audit')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Audit log' })).toHaveCount(0)
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

// Hosted only: the sign-up funnel has no controls of its own, so reaching it from the rail is the keyboard path
test('server admin, sign-up funnel', async ({ page }) => {
  const email = uniqueEmail('a11y-funnel')
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  await page.goto('/admin')
  const rail = page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Sign-up funnel' })
  await rail.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#funnel$/)
  const funnel = page.locator('#funnel')
  await expect(funnel.getByRole('table', { name: 'Steps' }).getByRole('row', { name: /Signed up/ })).toBeVisible()
  await expectAccessible(page, 'server admin, sign-up funnel', { include: '#funnel' })
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

// An instance admin of a licensed install, as licensedSso answers for one, on Server admin
async function ssoAdmin(page: Page, name: string, path = '/admin#sso') {
  const email = uniqueEmail(name)
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  await licensedSso(page)
  await page.goto(path)
}

test('single sign-on: sign-in buttons', async ({ browser }) => {
  const signedOutContext = await browser.newContext()
  const signedOut = await signedOutContext.newPage()
  await licensedSso(signedOut)
  await signedOut.goto('/login')
  await expect(signedOut.getByRole('link', { name: 'Continue with Okta' })).toBeVisible()
  await expectAccessible(signedOut, 'log in with single sign-on')
  await signedOut.goto('/login?error=sso_required')
  await expect(signedOut.getByRole('alert')).toContainText('single sign-on')
  await expectAccessible(signedOut, 'log in, single sign-on required')
  await signedOutContext.close()
})

test('single sign-on: OIDC provider in Server admin', async ({ page }) => {
  await ssoAdmin(page, 'a11y-sso-oidc', '/admin?sso-test=1#sso')
  const sso = page.locator('section#sso')
  await expect(sso.getByRole('heading', { name: /Single sign-on/ })).toBeVisible()
  await expect(sso.getByText('Okta signed in ada@acme.example')).toBeVisible()
  await expectAccessible(page, 'server admin, single sign-on with a test result')

  await sso.getByRole('button', { name: 'Edit Okta' }).click()
  await expect(sso.getByLabel('Issuer URL')).toHaveValue('https://acme.okta.com')
  await expectAccessible(page, 'server admin, editing a single sign-on connection')
  await sso.getByRole('button', { name: 'Close Okta' }).click()

  await sso.getByRole('button', { name: 'Remove Okta' }).click()
  await expect(sso.getByRole('group', { name: 'Confirm: remove Okta' })).toBeVisible()
  await expectAccessible(page, 'server admin, removing a single sign-on connection')
})

test('single sign-on: SAML provider', async ({ page }) => {
  await ssoAdmin(page, 'a11y-sso-saml')
  const sso = page.locator('section#sso')
  // By keyboard: the protocol choice, then the metadata fields
  await sso.getByRole('button', { name: 'Add a provider' }).click()
  await sso.getByRole('radio', { name: /OpenID Connect/ }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(sso.getByRole('radio', { name: /SAML/ })).toBeChecked()
  await expect(sso.getByLabel('Metadata URL')).toBeVisible()
  await expectAccessible(page, 'server admin, adding a SAML connection')
})

test('SCIM provisioning', async ({ page }) => {
  await ssoAdmin(page, 'a11y-scim', '/admin#scim')
  const scim = page.locator('section#scim')
  await expect(scim.getByRole('heading', { name: /Provisioning \(SCIM\)/ })).toBeVisible()
  await scim.getByLabel('Token name').focus()
  await page.keyboard.type('Entra ID')
  await page.keyboard.press('Enter')
  await expect(scim.getByText('It is not shown again.')).toBeVisible()
  await expectAccessible(page, 'server admin, a new SCIM token')
})
