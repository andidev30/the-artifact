import { expect, test } from '@playwright/test'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

// A 4x4 red PNG
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'

test('compare two versions of a multi-file page side by side and as changes', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('compare'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, {
    title: 'Pricing',
    html: '<!doctype html>\n<link rel="stylesheet" href="site.css">\n<h1>Pricing, draft</h1>\n',
    files: [
      { path: 'site.css', content: 'h1 { color: red }\n' },
      { path: 'old.js', content: 'console.log("old")\n' },
    ],
  })
  await publishViaMcp(page.request, token, {
    title: 'Pricing',
    html: '<!doctype html>\n<link rel="stylesheet" href="site.css">\n<h1>Pricing, final</h1>\n',
    artifact_id: slug,
    files: [
      { path: 'site.css', content: 'h1 { color: red }\n' },
      { path: 'img/dot.png', content: RED_PNG, encoding: 'base64' },
    ],
  })

  // Pick both versions in the history, with the keyboard
  await page.goto(`/a/${slug}`)
  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('complementary', { name: 'Version history' })
  const compare = history.getByRole('button', { name: 'Compare' })
  await expect(compare).toBeDisabled()
  for (const n of [1, 2]) {
    await history.getByRole('checkbox', { name: `Compare version ${n}` }).focus()
    await page.keyboard.press('Space')
  }
  await expect(history.getByText('Version 1 and version 2.')).toBeVisible()
  await compare.focus()
  await page.keyboard.press('Enter')

  // Side by side: both versions render with their own files, through the same sandboxed frames as the viewer
  await expect(page).toHaveURL(new RegExp(`/a/${slug}/compare\\?from=1&to=2$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Compare versions' })).toBeVisible()
  const from = page.frameLocator('iframe[title="Pricing, version 1"]')
  const to = page.frameLocator('iframe[title="Pricing, version 2"]')
  await expect(from.getByRole('heading', { name: 'Pricing, draft' })).toBeVisible()
  await expect(to.getByRole('heading', { name: 'Pricing, final' })).toBeVisible()
  await expect(from.getByRole('heading')).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(page.locator('iframe.compare-frame').first()).toHaveAttribute('sandbox', /allow-scripts/)

  // Changes: the file list with a line diff of the text files
  await page.getByRole('button', { name: 'Changes' }).click()
  await expect(page.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('3 files differ: 1 changed, 1 added, 1 removed, 1 unchanged.')).toBeVisible()
  const html = page.getByRole('region', { name: 'Changed: index.html' })
  await expect(html.locator('.diff-row[data-kind="removed"]')).toHaveText(/Removed: <h1>Pricing, draft<\/h1>/)
  await expect(html.locator('.diff-row[data-kind="added"]')).toHaveText(/Added: <h1>Pricing, final<\/h1>/)
  await expect(html.locator('.diff-row[data-kind="added"] .diff-marker')).toHaveText('+')
  await expect(page.getByRole('region', { name: 'Added: img/dot.png' }).getByText('Not a text file, so there is no line diff.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Removed: old.js' }).locator('.diff-row[data-kind="removed"]')).toHaveText(/console\.log\("old"\)/)

  // The other order, picked at the top, reads the other way round
  await page.getByLabel('From', { exact: true }).selectOption('2')
  await page.getByLabel('To', { exact: true }).selectOption('1')
  await expect(page).toHaveURL(/from=2&to=1&view=changes$/)
  await expect(page.getByRole('region', { name: 'Added: old.js' })).toBeVisible()

  // Phone width: the two versions stack and nothing scrolls sideways
  await page.setViewportSize({ width: 375, height: 740 })
  await page.getByRole('button', { name: 'Side by side' }).click()
  const [first, second] = await Promise.all([page.locator('.compare-side').first().boundingBox(), page.locator('.compare-side').last().boundingBox()])
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height - 2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Changes' }).click()
  await expect(page.getByRole('region', { name: 'Changed: index.html' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('link', { name: 'Back to page' }).click()
  await expect(page).toHaveURL(new RegExp(`/a/${slug}$`))
})
