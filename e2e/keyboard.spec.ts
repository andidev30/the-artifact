import { expect, test, type Locator, type Page } from '@playwright/test'
import { forgetSignInLinks } from '../apps/api/test/e2e-db.ts'
import { connectAgent, latestMail, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

// Every flow here is driven with the keyboard alone: no clicks, no fill()

async function tabTo(page: Page, target: Locator, { max = 60, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab')
  }
  await expect(target, 'reachable with Tab').toBeFocused()
}

// Focus has to be visible: an outline, or the box shadow some fields use instead
async function expectFocusRing(target: Locator) {
  await expect(target).toBeFocused()
  const ring = await target.evaluate((el) => {
    const style = getComputedStyle(el)
    return (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
  })
  expect(ring, 'visible focus ring').toBe(true)
}

const focusInside = (page: Page, selector: string) => page.evaluate((s) => Boolean(document.querySelector(s)?.contains(document.activeElement)), selector)
const focusLost = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null)

test('sign in with a sign-in link', async ({ page }) => {
  const email = uniqueEmail('kb-sign-in')
  await signUpPersonal(page, email)
  await page.request.post('/api/auth/logout')
  await page.context().clearCookies()
  await forgetSignInLinks(email)

  await page.goto('/login')
  // The first stop on every page skips the header
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expectFocusRing(skip)
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()

  const field = page.getByLabel('Email')
  await tabTo(page, field)
  await expectFocusRing(field)
  await page.keyboard.type(email)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()

  const text = await latestMail(page.request, email, /sign-in link/i)
  await page.goto(text.match(/https?:\/\/\S+\/auth\/confirm\?\S+/)![0])
  const go = page.getByRole('button', { name: `Continue as ${email}` })
  await tabTo(page, go)
  await expectFocusRing(go)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/app$/)
})

test('open a page from the gallery, share it, and use its history, comments and menu', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('kb-viewer'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<h1>Plan</h1>', visibility: 'link' })
  await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<h1>Plan, second draft</h1>', artifact_id: slug })
  await page.goto('/app')

  // The gallery's tabs: one tab stop, arrow keys switch
  const workspaceTab = page.getByRole('tab', { name: 'Personal' })
  await tabTo(page, workspaceTab)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Shared with you' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Shared with you' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Nothing has been shared with you yet.')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true')

  // Opening a page moves focus to its title
  const card = page.getByRole('link', { name: 'Launch plan' })
  await tabTo(page, card)
  await expect(page.locator('.page-card').filter({ has: card })).toHaveCSS('outline-style', 'solid')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/a/${slug}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeFocused()

  // The share dialog takes focus, keeps it while tabbing, and gives it back on Escape
  const shareButton = page.getByRole('button', { name: 'Share', exact: true })
  await tabTo(page, shareButton)
  await expectFocusRing(shareButton)
  await page.keyboard.press('Enter')
  const share = page.getByRole('dialog', { name: 'Share “Launch plan”' })
  await expect(share).toBeVisible()
  await expect(share.getByLabel('Add people by email')).toBeFocused()
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    // Past the last control the browser may step out to its own toolbar, never to the page behind
    expect((await focusInside(page, 'dialog[open]')) || (await focusLost(page))).toBe(true)
  }
  await tabTo(page, share.getByLabel('Who can open with the link'))
  await tabTo(page, share.getByRole('button', { name: 'Copy embed code' }))
  await page.keyboard.press('Escape')
  await expect(share).toBeHidden()
  await expect(shareButton).toBeFocused()

  // History: the panel takes focus, a version opens with Enter, Escape closes it
  const historyButton = page.getByRole('button', { name: 'History', exact: true })
  await tabTo(page, historyButton, { back: true })
  await page.keyboard.press('Enter')
  await expect(historyButton).toHaveAttribute('aria-expanded', 'true')
  const history = page.getByRole('complementary', { name: 'Version history' })
  await expect(history.getByRole('heading', { name: 'Version history' })).toBeFocused()
  const first = history.getByRole('button', { name: /Version 1/ })
  await tabTo(page, first)
  await expectFocusRing(first)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Older version' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(history).toBeHidden()
  await expect(historyButton).toBeFocused()
  await expect(historyButton).toHaveAttribute('aria-expanded', 'false')
  await tabTo(page, page.getByRole('button', { name: 'Back to latest' }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: 'Older version' })).toBeHidden()
  expect(await focusLost(page)).toBe(false)

  // Comments: write one, then Escape back to the button
  const commentsButton = page.getByRole('button', { name: /^Comments/ })
  await tabTo(page, commentsButton, { back: true })
  await page.keyboard.press('Enter')
  const comments = page.getByRole('complementary', { name: 'Comments' })
  await expect(comments.getByRole('heading', { name: 'Comments' })).toBeFocused()
  await tabTo(page, comments.getByLabel('New comment'))
  await page.keyboard.type('Needs a legend')
  await tabTo(page, comments.getByRole('button', { name: 'Comment', exact: true }))
  await page.keyboard.press('Enter')
  await expect(comments.locator('.comment-body')).toHaveText('Needs a legend')
  // Edit, then cancel: focus stays in the comment instead of falling to the top of the page
  await tabTo(page, comments.getByRole('button', { name: 'Edit' }), { back: true })
  await page.keyboard.press('Enter')
  await expect(comments.getByLabel('Edit comment')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(comments.getByLabel('Edit comment')).toHaveCount(0)
  expect(await focusInside(page, '#comments-panel')).toBe(true)
  await page.keyboard.press('Escape')
  await expect(comments).toBeHidden()
  await expect(commentsButton).toBeFocused()

  // The menu button pattern: arrow keys open and move, Escape closes and returns focus
  const more = page.getByRole('button', { name: 'More actions' })
  await tabTo(page, more)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeFocused()
  await expectFocusRing(page.getByRole('menuitem', { name: 'Download' }))
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(more).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('Enter')
  const rename = page.getByRole('dialog', { name: 'Rename page' })
  await expect(rename.getByLabel('Name')).toBeFocused()
  await page.keyboard.type('Launch plan v2')
  await page.keyboard.press('Enter')
  await expect(rename).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan v2' })).toBeVisible()
  await expect(more).toBeFocused()
})

test('move a page to a folder from its card menu', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('kb-folders'))
  const token = await connectAgent(page)
  await publishViaMcp(page.request, token, { title: 'Roadmap Q3', html: '<h1>Q3</h1>', folder: 'Plans' })
  await publishViaMcp(page.request, token, { title: 'Roadmap draft', html: '<h1>Draft</h1>' })
  await page.goto('/app')

  const more = page.getByRole('button', { name: 'More actions for Roadmap draft' })
  await tabTo(page, more)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Move to folder' })).toBeFocused()
  await page.keyboard.press('Enter')

  const move = page.getByRole('dialog', { name: 'Move “Roadmap draft”' })
  await expect(move.getByLabel('No folder')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(move.getByLabel('Plans')).toBeChecked()
  await page.keyboard.press('Enter')
  await expect(move).toBeHidden()
  await expect(more).toBeFocused()
  await expect(page.locator('.page-card', { has: page.getByRole('link', { name: 'Roadmap draft' }) })).toContainText('Plans')

  // Escape closes the dialog without moving anything, and focus goes back to the menu button
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(move).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(move).toBeHidden()
  await expect(more).toBeFocused()
})

test('account menu and settings forms', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('kb-settings'))
  await page.goto('/app')

  const account = page.getByRole('button', { name: /^Account:/ })
  await tabTo(page, account)
  await expectFocusRing(account)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('link', { name: 'Account settings' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Log out' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('link', { name: 'Account settings' })).toBeHidden()
  await expect(account).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeFocused()

  const name = page.getByLabel('Display name')
  await tabTo(page, name)
  await expectFocusRing(name)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Key Board')
  await page.keyboard.press('Enter')
  await expect(page.locator('#profile-status')).toHaveText('Saved.')

  const tokens = page.locator('section#tokens')
  await tabTo(page, tokens.getByLabel('Name'))
  await page.keyboard.type('Nightly report')
  await page.keyboard.press('Enter')
  await expect(tokens.locator('.settings-token-new')).toBeVisible()
  await tabTo(page, tokens.getByRole('button', { name: 'Done' }))
  await page.keyboard.press('Enter')
  await expect(tokens.locator('.settings-token-new')).toHaveCount(0)
  expect(await focusLost(page)).toBe(false)

  // Revoke asks first; cancelling puts focus back on Revoke
  const row = tokens.getByRole('listitem').filter({ hasText: 'Nightly report' })
  const revoke = row.getByRole('button', { name: 'Revoke Nightly report' })
  await tabTo(page, revoke)
  await page.keyboard.press('Enter')
  await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toBeFocused()
  await tabTo(page, row.getByRole('button', { name: 'Cancel' }))
  await page.keyboard.press('Enter')
  await expect(revoke).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(row).toHaveCount(0)
  expect(await focusLost(page)).toBe(false)
})
