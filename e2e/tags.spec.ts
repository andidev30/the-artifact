import { expect, test } from '@playwright/test'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

test('search inside pages, tag a page from its menu and filter the gallery by tag', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('tags'))
  const token = await connectAgent(page)
  await publishViaMcp(page.request, token, { title: 'Plain page', html: '<!doctype html><h1>Hello</h1>' })
  await publishViaMcp(page.request, token, { title: 'Launch plan', html: '<!doctype html><h1>Plan</h1><p>We launch the Heliotrope rocket.</p>' })
  await page.reload()

  const cards = page.locator('.gallery .page-card')
  await expect(cards).toHaveCount(2)

  // A word only in the body of a page
  const search = page.getByRole('searchbox', { name: 'Search pages by title or text' })
  await search.fill('heliotrope')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Launch plan')
  await search.fill('')
  await expect(cards).toHaveCount(2)

  // Tagging with the keyboard alone: the menu, the dialog, Enter to add, Escape to close
  await page.getByRole('button', { name: 'More actions for Launch plan' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Tags' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Tags for “Launch plan”' })
  await expect(dialog).toBeVisible()
  await page.keyboard.type('Launch, Q4')
  await page.keyboard.press('Enter')
  const onPage = dialog.getByRole('list', { name: 'Tags on this page' })
  await expect(onPage.getByRole('listitem')).toHaveText(['launch', 'q4'])
  await dialog.getByRole('button', { name: 'Remove q4' }).click()
  await expect(onPage.getByRole('listitem')).toHaveText(['launch'])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // Filter by the tag from the tag bar, then from the card's own tag
  await expect(cards.filter({ hasText: 'Launch plan' }).getByRole('button', { name: /^launch/ })).toBeVisible()
  const bar = page.getByRole('navigation', { name: 'Tags' })
  await bar.getByRole('button', { name: /launch/ }).click()
  await expect(cards).toHaveCount(1)
  await expect(page.locator('.gallery-filter').getByText('Pages tagged')).toBeVisible()
  await page.getByRole('button', { name: 'Show every page' }).click()
  await expect(cards).toHaveCount(2)
  await cards
    .filter({ hasText: 'Launch plan' })
    .getByRole('button', { name: /^launch/ })
    .click()
  await expect(cards).toHaveCount(1)
  await expect(bar.getByRole('button', { name: /launch/ })).toHaveAttribute('aria-pressed', 'true')
})
