import { createHash, randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { addHostedMember, createHostedOrganization, grantInstanceAdmin, requireHostedTwoFactor } from '../apps/api/test/e2e-db.ts'
import { expectAccessible } from './axe'
import {
  fromApp,
  connectAgent,
  latestMail,
  licensedSso,
  mockAuditLog,
  mockRetention,
  publishViaMcp,
  signInLink,
  signUp,
  signUpPersonal,
  uniqueEmail,
} from './helpers'

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

test('the server not answering, and an account that could not be loaded', async ({ page }) => {
  await page.route('**/api/config', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Can’t reach the server' })).toBeVisible()
  await expectAccessible(page, 'server unreachable')
  await page.unrouteAll()

  await page.route('**/api/me', (route) => route.fulfill({ status: 500, json: { error: 'Something went wrong' } }))
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Your account could not be loaded' })).toBeVisible()
  await expectAccessible(page, 'account could not be loaded')
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
test('folder rename and delete dialogs, and search results', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-folders'))
  const token = await connectAgent(page)
  await publishViaMcp(page.request, token, { title: 'Roadmap draft', html: HTML })
  await publishViaMcp(page.request, token, { title: 'Roadmap Q3', html: HTML, folder: 'Plans' })
  await publishViaMcp(page.request, token, { title: 'Launch notes', html: HTML })
  await page.reload()
  const gallery = page.locator('ul.gallery')
  await expect(gallery.locator('.page-card')).toHaveCount(3)

  const folders = page.getByRole('navigation', { name: 'Folders' })
  await folders.getByRole('button', { name: /Plans/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Plans' })).toBeVisible()
  await expect(page.locator('.page-card')).toHaveCount(1)

  // By keyboard: each dialog opens on its first control and gives focus back to the button that opened it
  const renameFolder = page.locator('.folder-head').getByRole('button', { name: 'Rename' })
  await renameFolder.press('Enter')
  const rename = page.getByRole('dialog', { name: 'Rename folder' })
  await expect(rename.getByLabel('Name')).toBeFocused()
  await expect(rename.getByLabel('Name')).toHaveValue('Plans')
  await expectAccessible(page, 'rename folder dialog')
  await page.keyboard.type('x'.repeat(81))
  await expect(rename.getByText('characters over the 80 limit')).toBeVisible()
  await expectAccessible(page, 'rename folder dialog, a name too long')
  await page.keyboard.press('Escape')
  await expect(renameFolder).toBeFocused()

  const deleteFolder = page.locator('.folder-head').getByRole('button', { name: 'Delete folder' })
  await deleteFolder.press('Enter')
  const remove = page.getByRole('dialog', { name: 'Delete the folder “Plans”?' })
  await expect(remove.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expectAccessible(page, 'delete folder dialog')
  await page.keyboard.press('Enter')
  await expect(remove).toHaveCount(0)
  await expect(deleteFolder).toBeFocused()
  await folders.getByRole('button', { name: /All pages/ }).click()
  await expect(page.locator('.page-card')).toHaveCount(3)

  const search = page.getByRole('searchbox', { name: 'Search pages by title' })
  await search.fill('roadmap')
  await expect(gallery.locator('.page-card')).toHaveCount(2)
  await expect(page.locator('.gallery[data-stale]')).toHaveCount(0)
  await expectAccessible(page, 'gallery, search results')
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
  await history.getByRole('button', { name: 'Compare', exact: true }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Compare versions' })).toBeVisible()
  await expect(page.frameLocator('iframe[title="Launch plan, version 2"]').getByRole('heading', { name: 'Plan, second draft' })).toBeVisible()
  await expectAccessible(page, 'versions side by side')

  await page.getByRole('button', { name: 'Changes' }).click()
  await expect(page.getByRole('region', { name: 'Changed: site.css' })).toBeVisible()
  await expectAccessible(page, 'changes between versions')
})

test('duplicate and move to another workspace dialogs', async ({ page }) => {
  const email = uniqueEmail('a11y-transfer')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Transfer Co')
  await page.evaluate((id) => localStorage.setItem('the-artifact.workspace', id), org.id)
  const token = await connectAgent(page, org.id)
  await publishViaMcp(page.request, token, { title: 'Budget', html: HTML })
  await page.reload()
  await expect(page.getByRole('list', { name: 'Pages in Transfer Co' }).locator('.page-card')).toHaveCount(1)

  await page.getByRole('button', { name: 'More actions for Budget' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  const duplicate = page.getByRole('dialog', { name: 'Duplicate “Budget”' })
  await expect(duplicate.getByRole('radio', { name: 'Transfer Co' })).toBeChecked()
  await expect(duplicate.getByLabel('Name of the copy')).toHaveValue('Budget (copy)')
  await expectAccessible(page, 'duplicate dialog')
  await page.keyboard.press('Escape')

  // Keyboard alone: open the menu, pick the item, choose Personal with the arrow keys
  await page.getByRole('button', { name: 'More actions for Budget' }).focus()
  await page.keyboard.press('ArrowDown')
  await page.getByRole('menuitem', { name: 'Move to workspace…' }).focus()
  await page.keyboard.press('Enter')
  const move = page.getByRole('dialog', { name: 'Move “Budget” to another workspace' })
  await expect(move.getByRole('radio', { name: 'Personal' })).toBeChecked()
  await expect(move.getByRole('radio', { name: /Transfer Co/ })).toBeDisabled()
  await expectAccessible(page, 'move to another workspace dialog')
  await page.keyboard.press('Escape')
})

test('tags: the tag bar, tags on cards and the tags dialog', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-tags'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Tagged page', html: HTML })
  const res = await page.request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tag_artifact', arguments: { artifact_id: slug, add: ['launch', 'q4'] } } },
  })
  expect(res.status()).toBe(200)
  await page.reload()

  await expect(page.getByRole('navigation', { name: 'Tags' }).getByRole('button', { name: /launch/ })).toBeVisible()
  await expectAccessible(page, 'gallery with tags')
  await page.getByRole('navigation', { name: 'Tags' }).getByRole('button', { name: /q4/ }).click()
  await expect(page.locator('.gallery-filter').getByText('Pages tagged')).toBeVisible()
  await expect(page.locator('.gallery[data-stale]')).toHaveCount(0)
  await expectAccessible(page, 'gallery filtered by a tag')

  await page.getByRole('button', { name: 'More actions for Tagged page' }).click()
  await page.getByRole('menuitem', { name: 'Tags' }).click()
  await expect(page.getByRole('dialog', { name: 'Tags for “Tagged page”' })).toBeVisible()
  await expectAccessible(page, 'tags dialog')
  await page.getByLabel('Add tags').fill('x'.repeat(40))
  await expect(page.getByText('over the 32 character limit')).toBeVisible()
  await expectAccessible(page, 'tags dialog, a tag too long')
  await page.keyboard.press('Escape')

  await page.goto(`/a/${slug}`)
  await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['launch', 'q4'])
  await expectAccessible(page, 'viewer with tags')
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

test('pinning a comment to an element, and its pin', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-pins'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<!doctype html><title>Plan</title><h1>Plan</h1><p>Revenue</p>' })

  await page.goto(`/a/${slug}`)
  await expect(page.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Plan' })).toBeVisible()
  await page.getByRole('button', { name: 'Comments' }).click()
  const comments = page.getByRole('complementary', { name: 'Comments' })
  await comments.getByRole('button', { name: 'Pin to an element' }).click()
  await expect(page.getByRole('group', { name: 'Pin a comment to an element' })).toBeVisible()
  await expectAccessible(page, 'picking an element')
  await page.locator('iframe.viewer-frame').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(comments.getByText('Pinned to “Plan”')).toBeVisible()
  await expectAccessible(page, 'comment pinned to an element')
  await comments.getByLabel('New comment').fill('Bigger heading')
  await comments.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Comment 1: Bigger heading' })).toBeVisible()
  await expectAccessible(page, 'thread with a pin on the page')
})

test('comments: a reply, editing, deleting, a resolved thread and an element that changed', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-threads'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<!doctype html><title>Plan</title><h1>Plan</h1><p>Revenue</p>' })

  await page.goto(`/a/${slug}`)
  await expect(page.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Plan' })).toBeVisible()
  await page.getByRole('button', { name: 'Comments' }).click()
  const comments = page.getByRole('complementary', { name: 'Comments' })
  await comments.getByRole('button', { name: 'Pin to an element' }).click()
  await expect(page.locator('iframe.viewer-frame')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(comments.getByText('Pinned to “Plan”')).toBeVisible()
  await comments.getByLabel('New comment').fill('Bigger heading')
  await comments.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(comments.getByText('About “Plan”')).toBeVisible()
  await comments.getByLabel('New comment').fill('Needs a legend')
  await comments.getByRole('button', { name: 'Comment', exact: true }).click()
  const thread = comments.locator('[data-thread]').filter({ hasText: 'Needs a legend' })
  await expect(thread).toBeVisible()

  // With the keyboard: Reply opens a field with focus, Ctrl+Enter sends it
  await thread.getByRole('button', { name: 'Reply' }).press('Enter')
  await expect(thread.getByLabel('Reply')).toBeFocused()
  await page.keyboard.type('Added in version 2')
  await expectAccessible(page, 'comments panel, writing a reply')
  await page.keyboard.press('Control+Enter')
  const reply = thread.locator('.comment-replies .comment')
  await expect(reply.locator('.comment-body')).toHaveText('Added in version 2')

  await reply.getByRole('button', { name: 'Edit' }).press('Enter')
  await expect(reply.getByLabel('Edit comment')).toBeFocused()
  await expectAccessible(page, 'comments panel, editing a comment')
  // Escape leaves the edit, not the panel
  await page.keyboard.press('Escape')
  await expect(reply.locator('.comment-body')).toHaveText('Added in version 2')
  await expect(comments).toBeVisible()

  await thread.locator('.comment').first().getByRole('button', { name: 'Delete' }).press('Enter')
  const confirm = thread.getByRole('group', { name: 'Delete comment' })
  await expect(confirm).toContainText('Delete this comment and its reply?')
  await expect(confirm.getByRole('button', { name: 'Delete' })).toBeFocused()
  await expectAccessible(page, 'comments panel, delete confirmation')
  await confirm.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(confirm).toHaveCount(0)
  await expect(thread.locator('.comment').first().getByRole('button', { name: 'Delete' })).toBeFocused()

  await thread.getByRole('button', { name: 'Resolve' }).click()
  const resolved = comments.locator('.comment-thread[data-resolved]')
  await expect(resolved.getByText(/^Resolved by/)).toBeVisible()
  await expectAccessible(page, 'comments panel, a resolved thread')
  await resolved.getByRole('button', { name: 'Show' }).press('Enter')
  await expect(resolved.getByRole('button', { name: 'Hide' })).toBeVisible()
  await expectAccessible(page, 'comments panel, a resolved thread shown')

  // A version without the heading: the pinned thread says its element changed
  await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<!doctype html><title>Plan</title><p>Revenue</p>', artifact_id: slug })
  await page.reload()
  await page.getByRole('button', { name: 'Comments' }).click()
  await expect(comments.getByText('The element this comment is about has changed. It was “Plan”.')).toBeVisible()
  await expectAccessible(page, 'comments panel, an element that changed')
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

test('account settings: disconnecting an agent, revoking a token and deleting the account', async ({ page }) => {
  const email = uniqueEmail('a11y-confirms')
  await signUpPersonal(page, email)
  // A page in an organization with another owner, which stays there when the account goes
  const org = await createOrganization(email, 'Stay Co')
  await addHostedMember(org.id, uniqueEmail('a11y-co-owner'), 'owner')
  await publishViaMcp(page.request, await connectAgent(page, org.id), { title: 'Budget', html: HTML })

  await page.goto('/settings')
  const tokens = page.locator('section#tokens')
  await tokens.getByLabel('Name').fill('Nightly report')
  await tokens.getByRole('button', { name: 'Create token' }).click()
  await tokens.getByRole('button', { name: 'Done' }).click()
  const revoke = tokens.getByRole('button', { name: 'Revoke Nightly report' })
  await revoke.press('Enter')
  await expect(tokens.getByRole('button', { name: 'Revoke', exact: true })).toBeFocused()
  await expectAccessible(page, 'account settings, revoke confirmation')
  await tokens.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(revoke).toBeFocused()

  const agents = page.locator('section#agents')
  const disconnect = agents.getByRole('button', { name: 'Disconnect' })
  await disconnect.press('Enter')
  await expect(agents.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(disconnect).toBeFocused()
  await expectAccessible(page, 'account settings, disconnect confirmation')
  await agents.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(disconnect).toBeFocused()

  const remove = page.locator('section#delete')
  await expect(remove.getByText('1 page in Stay Co stays.')).toBeVisible()
  await remove.getByLabel(/to confirm/).fill(email)
  await expect(remove.getByRole('button', { name: 'Delete account' })).toBeEnabled()
  await expectAccessible(page, 'account settings, delete account confirmation')

  // The only owner of an organization other people are in can't delete the account yet
  const blocking = await createOrganization(email, 'Blocking Co')
  await addHostedMember(blocking.id, uniqueEmail('a11y-member'))
  await page.reload()
  await expect(remove.getByRole('alert')).toContainText('You are the only owner of Blocking Co')
  await expectAccessible(page, 'account settings, delete account blocked')
})

test('organization settings: removing a member, and an organization that requires two-factor sign-in', async ({ page }) => {
  const email = uniqueEmail('a11y-members')
  await signUpPersonal(page, email)
  const org = await createOrganization(email, 'Members Co')
  const member = uniqueEmail('a11y-removed')
  await addHostedMember(org.id, member)

  await page.goto(`/organizations/${org.slug}/settings#members`)
  const row = page.getByRole('listitem').filter({ hasText: member })
  const remove = row.getByRole('button', { name: 'Remove' })
  await remove.press('Enter')
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(remove).toBeFocused()
  await expectAccessible(page, 'organization settings, remove member confirmation')
  await row.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(remove).toBeFocused()

  // Its owner turns on two-factor sign-in without having a second factor: this account is shut out
  const strict = await createOrganization(email, 'Strict Co')
  await requireHostedTwoFactor(strict.id)
  await page.goto('/app')
  await expect(page.getByText('Strict Co requires two-factor sign-in.')).toBeVisible()
  await expectAccessible(page, 'gallery, an organization requires two-factor sign-in')
  await page.goto(`/organizations/${strict.slug}/settings`)
  await expect(page.getByRole('heading', { name: 'Two-factor sign-in required' })).toBeVisible()
  await expectAccessible(page, 'organization settings, two-factor sign-in required')
})

test('invitations: in onboarding, on your pages, and opened signed in, then declined', async ({ page, browser }) => {
  const owner = uniqueEmail('a11y-inviter')
  await signUpPersonal(page, owner)
  const org = await createOrganization(owner, 'Invite Co')
  const guest = uniqueEmail('a11y-guest')
  expect(
    (await page.request.post(`/api/organizations/${org.id}/invitations`, { headers: fromApp(page), data: { email: guest, role: 'member' } })).status(),
  ).toBe(201)
  const link = (await latestMail(page.request, guest, /invit/i)).match(/https?:\/\/\S+\/invite\/\S+/)?.[0]
  expect(link, 'invitation link in email').toBeTruthy()

  const context = await browser.newContext()
  const them = await context.newPage()
  await signUp(them, guest)
  await expect(them.getByRole('heading', { name: 'You have an invitation' })).toBeVisible()
  await expectAccessible(them, 'onboarding, with an invitation')
  await them.getByRole('button', { name: 'Continue' }).click()
  await them.getByRole('link', { name: 'Go to your pages' }).click()
  await expect(them.getByRole('region', { name: 'Invitations' })).toBeVisible()
  await expectAccessible(them, 'gallery, with an invitation')

  await them.goto(new URL(link!).pathname)
  await expect(them.getByRole('heading', { level: 1, name: 'Join Invite Co' })).toBeVisible()
  await expect(them.getByRole('button', { name: 'Join Invite Co' })).toBeVisible()
  await expectAccessible(them, 'invitation, signed in')
  await them.getByRole('button', { name: 'Decline' }).press('Enter')
  await expect(them.getByRole('heading', { level: 1, name: 'Invitation declined' })).toBeVisible()
  await expectAccessible(them, 'invitation declined')
  await context.close()
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

test('webhooks in account settings', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('a11y-webhooks'))
  await page.goto('/settings#webhooks')
  const section = page.locator('section#webhooks')
  await expect(section.getByText('No webhooks yet.')).toBeVisible()

  // With the keyboard alone: open the form, fill it and add
  await section.getByRole('button', { name: 'Add webhook' }).focus()
  await page.keyboard.press('Enter')
  await expect(section.getByLabel('Address')).toBeFocused()
  // .invalid never resolves, so the test message fails at once without leaving the machine
  await page.keyboard.type('https://hooks.example.invalid/services/T000')
  await expect(section.getByLabel('New comment')).toBeChecked()
  await expectAccessible(page, 'account settings, new webhook form')
  await section.getByRole('button', { name: 'Add webhook' }).press('Enter')
  await expect(section.locator('.settings-token-new')).toBeVisible()
  await expect(section.getByRole('button', { name: 'Copy signing secret' })).toBeVisible()
  await expectAccessible(page, 'account settings, new webhook secret')
  await section.getByRole('button', { name: 'Done' }).click()

  await section.getByRole('button', { name: 'Send a test to hooks.example.invalid' }).press('Enter')
  await expect(section.getByText('hooks.example.invalid could not be found.')).toBeVisible()
  await section.getByRole('button', { name: 'Recent deliveries' }).press('Enter')
  await expect(section.getByRole('table', { name: 'Recent deliveries to hooks.example.invalid' })).toBeVisible()
  await expectAccessible(page, 'account settings, webhook deliveries')

  // Delete asks first, with focus on the answer; cancelling puts focus back on Delete
  const remove = section.getByRole('button', { name: 'Delete webhook to hooks.example.invalid' })
  await remove.press('Enter')
  await expect(section.getByRole('button', { name: 'Delete', exact: true })).toBeFocused()
  await expectAccessible(page, 'account settings, webhook delete confirmation')
  await page.keyboard.press('Tab')
  await expect(section.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(remove).toBeFocused()

  await section.getByRole('button', { name: 'Edit webhook to hooks.example.invalid' }).press('Enter')
  await expect(section.getByRole('button', { name: 'Save' })).toBeVisible()
  await expectAccessible(page, 'account settings, edit webhook')
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

test('server admin: confirmations and deleting an organization', async ({ page }) => {
  const email = uniqueEmail('a11y-admin-confirms')
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  const org = await createOrganization(email, 'Doomed Co')
  const someone = uniqueEmail('a11y-managed')
  await addHostedMember(org.id, someone)
  await page.goto('/admin')

  const people = page.locator('#people')
  await page.getByLabel('Search people').fill(someone)
  await expect(people.getByText('Showing 1 of 1 person')).toBeVisible()
  await people.getByRole('button', { name: 'Manage' }).click()
  await people.getByRole('button', { name: 'Suspend', exact: true }).press('Enter')
  const suspend = people.getByRole('group', { name: 'Confirm: Suspend' })
  await expect(suspend.getByRole('button', { name: 'Suspend' })).toBeFocused()
  await expectAccessible(page, 'server admin, suspend confirmation', { include: '#people' })
  await suspend.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(people.getByRole('button', { name: 'Suspend', exact: true })).toBeFocused()

  const deleteAccount = people.getByRole('button', { name: 'Delete account' })
  await deleteAccount.press('Enter')
  await expect(people.getByLabel(/to confirm/)).toBeFocused()
  await expect(people.getByText(`This deletes ${someone}`)).toBeVisible()
  await expectAccessible(page, 'server admin, delete account confirmation', { include: '#people' })
  await people.locator('form.admin-confirm').getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(deleteAccount).toBeFocused()

  // Delete opens the confirmation below it and becomes Cancel, keeping focus; the field is next
  const organizations = page.locator('#organizations')
  await page.getByLabel('Search organizations').fill(org.slug)
  const row = organizations.getByRole('listitem').filter({ hasText: org.slug })
  const toggle = row.locator('.settings-actions button')
  await expect(toggle).toHaveText('Delete')
  await toggle.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.getByLabel(/to confirm/)).toBeFocused()
  await expectAccessible(page, 'server admin, delete organization confirmation', { include: '#organizations' })
  await row.locator('form').getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(toggle).toHaveText('Delete')
  await expect(toggle).toBeFocused()
})

// The e2e servers send email and have no signing key, so these are shown by answering the API the way a
// server without email, and the hosted service with its signing key, would
test('server admin: a sign-up link and a newly issued license key', async ({ page }) => {
  const email = uniqueEmail('a11y-admin-links')
  await signUpPersonal(page, email)
  await grantInstanceAdmin(email)
  await page.route('**/api/config', async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), emailSignIn: false } }))
  await page.route('**/api/admin/sign-up-links', (route) =>
    route.fulfill({
      status: 201,
      json: { email: 'new@example.com', link: 'http://localhost:5177/auth/set-password?token=e2e', newAccount: true, expiresAt: '2099-01-08T00:00:00.000Z' },
    }),
  )
  const license = {
    id: '3c2b1a00-0000-4000-8000-000000000001',
    customerName: 'Acme Inc',
    customerEmail: 'it@acme.example',
    seats: 50,
    issuedAt: '2026-09-29T00:00:00.000Z',
    expiresAt: '2027-09-29T23:59:59.000Z',
    issuedBy: email,
  }
  await page.route('**/api/admin/issued-licenses', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { key: 'e2e-license-key-shown-once', license } })
      : route.fulfill({ json: { available: true, reason: null, licenses: [] } }),
  )
  await page.goto('/admin')

  await page.getByLabel('Add someone').fill('new@example.com')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await expectAccessible(page, 'server admin, a new sign-up link', { include: '#people' })

  const keys = page.locator('#license-keys')
  await keys.getByLabel('Customer', { exact: true }).fill('Acme Inc')
  await keys.getByLabel('Customer email').fill('it@acme.example')
  await keys.getByLabel('Seats').fill('50')
  await keys.getByRole('button', { name: 'Issue key' }).press('Enter')
  await expect(keys.locator('.issue-result')).toBeFocused()
  await expect(keys.getByRole('button', { name: 'Copy license key' })).toBeVisible()
  await expectAccessible(page, 'server admin, a newly issued license key', { include: '#license-keys' })
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
