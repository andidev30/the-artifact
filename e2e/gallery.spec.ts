import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><h1>Page</h1>'
// One more than the gallery loads at first (50), so the rest arrive by scrolling
const PAGES = 56

test('search, file pages into folders and scroll through a long gallery', async ({ page }) => {
  test.setTimeout(120_000)
  await signUpPersonal(page, uniqueEmail('folders'))
  // An organization, since the free Personal plan stops at 50 pages
  const created = await page.request.post('/api/organizations', { data: { name: 'Folder Co', slug: `e2e-${randomBytes(4).toString('hex')}` } })
  expect(created.status()).toBe(201)
  const org = (await created.json()) as { id: string }
  await page.evaluate((id) => localStorage.setItem('the-artifact.workspace', id), org.id)
  const token = await connectAgent(page, org.id)

  // Oldest first, so the roadmaps end up at the top of the gallery
  for (let i = 0; i < PAGES - 3; i++) await publishViaMcp(page.request, token, { title: `Report ${String(i).padStart(2, '0')}`, html: HTML })
  await publishViaMcp(page.request, token, { title: 'Roadmap draft', html: HTML })
  await publishViaMcp(page.request, token, { title: 'Roadmap Q3', html: HTML, folder: 'Plans' })
  await publishViaMcp(page.request, token, { title: 'Roadmap Q4', html: HTML, folder: 'Plans' })

  await page.reload()
  const gallery = page.getByRole('list', { name: 'Pages in Folder Co' })
  const cards = gallery.locator('.page-card')
  await expect(cards).toHaveCount(50)
  const folders = page.getByRole('navigation', { name: 'Folders' })
  await expect(folders.getByRole('button', { name: /All pages/ })).toContainText(String(PAGES))
  await expect(cards.first()).toContainText('Plans')

  // Scrolling to the end loads the rest
  await page.getByRole('button', { name: 'Show more pages' }).scrollIntoViewIfNeeded()
  await expect(cards).toHaveCount(PAGES)
  await expect(page.getByRole('button', { name: 'Show more pages' })).toHaveCount(0)
  await expect(gallery.getByRole('link', { name: 'Report 00' })).toBeVisible()

  // Search by title, ignoring case
  const search = page.getByRole('searchbox', { name: 'Search pages by title' })
  await search.fill('ROADMAP')
  await expect(cards).toHaveCount(3)
  await search.fill('nothing like this')
  await expect(page.getByText('No pages match “nothing like this”.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(cards).toHaveCount(50)

  // A folder the agent created
  await folders.getByRole('button', { name: /Plans/ }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Plans' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Pages in Plans' }).locator('.page-card')).toHaveCount(2)

  // A new folder, and a page moved into it from its menu
  await folders.getByRole('button', { name: 'New folder' }).click()
  const create = page.getByRole('dialog', { name: 'New folder' })
  await create.getByLabel('Name').fill('Launch')
  await create.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Launch' })).toBeVisible()
  await expect(page.getByText('Nothing in this folder yet.')).toBeVisible()

  await folders.getByRole('button', { name: /All pages/ }).click()
  await page.getByRole('button', { name: 'More actions for Roadmap draft' }).click()
  await page.getByRole('menuitem', { name: 'Move to folder' }).click()
  const move = page.getByRole('dialog', { name: 'Move “Roadmap draft”' })
  await move.getByLabel('Launch').check()
  await move.getByRole('button', { name: 'Move' }).click()
  await expect(move).toBeHidden()
  await expect(page.locator('.page-card', { has: page.getByRole('link', { name: 'Roadmap draft' }) })).toContainText('Launch')
  await expect(folders.getByRole('button', { name: /Launch/ })).toContainText('1')

  // Search inside a folder
  await folders.getByRole('button', { name: /Plans/ }).click()
  await search.fill('q4')
  await expect(page.getByRole('list', { name: 'Pages in Plans' }).locator('.page-card')).toHaveCount(1)
  await search.fill('')

  // Rename, then delete the folder: its page stays, in no folder
  await folders.getByRole('button', { name: /Launch/ }).click()
  await page.getByRole('button', { name: 'Rename' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename folder' })
  await rename.getByLabel('Name').fill('Launch week')
  await rename.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Launch week' })).toBeVisible()

  await page.getByRole('button', { name: 'Delete folder' }).click()
  const remove = page.getByRole('dialog', { name: 'Delete the folder “Launch week”?' })
  await remove.getByRole('button', { name: 'Delete folder' }).click()
  await expect(folders.getByRole('button', { name: /Launch week/ })).toHaveCount(0)
  await expect(folders.getByRole('button', { name: /All pages/ })).toHaveAttribute('aria-pressed', 'true')
  await folders.getByRole('button', { name: /No folder/ }).click()
  await expect(page.getByRole('link', { name: 'Roadmap draft' })).toBeVisible()
})
