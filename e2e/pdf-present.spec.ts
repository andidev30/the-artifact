import { expect, type Page, test } from '@playwright/test'
import { expectAccessible } from './axe'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

// The e2e servers render no thumbnails (CHROME_PATH is empty), so they make no PDFs either: the server
// is made to say it does, and its PDFs are stood in for. Printing itself is in apps/api/test/integration/pdf.test.ts.
async function serverMakesPdfs(page: Page, answer: () => Promise<{ status: number; body: string; headers?: Record<string, string> }>) {
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), pdf: true } })
  })
  await page.route('**/api/artifacts/*/pdf*', async (route) => {
    const { status, body, headers } = await answer()
    await route.fulfill({ status, body, headers })
  })
}

test('downloading a page as a PDF, and what the viewer says when it fails', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('pdf'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Quarterly report', html: '<!doctype html><title>Report</title><h1>Report</h1>' })

  let release = () => {}
  let fail = false
  await serverMakesPdfs(page, async () => {
    // Held until the test has seen the notice
    await new Promise<void>((r) => (release = r))
    return fail
      ? {
          status: 422,
          body: JSON.stringify({ error: 'The PDF could not be made: Making the PDF took longer than 20000 ms.' }),
          headers: { 'content-type': 'application/json' },
        }
      : {
          status: 200,
          body: '%PDF-1.7\n',
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="quarterly-report-v1.pdf"' },
        }
  })

  await page.goto(`/a/${slug}`)
  await expect(page.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Report' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download PDF' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Making a PDF of version 1' })).toBeVisible()
  await expectAccessible(page, 'viewer, making a PDF')
  release()
  expect((await downloading).suggestedFilename()).toBe('quarterly-report-v1.pdf')
  await expect(page.getByText('Making a PDF')).toBeHidden()

  fail = true
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Download PDF' }).click()
  await expect(page.getByText('Making a PDF of version 1')).toBeVisible()
  release()
  await expect(page.getByRole('alert')).toHaveText('The PDF could not be made: Making the PDF took longer than 20000 ms.')
  await expectAccessible(page, 'viewer, PDF failed')
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('alert')).toBeHidden()
})

test('servers without a browser offer no PDF', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('no-pdf'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Plain', html: '<!doctype html><title>Plain</title><h1>Plain</h1>' })
  await page.goto(`/a/${slug}`)
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Download PDF' })).toHaveCount(0)
})

test('presenting a page full screen, with its own keys working at once', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('present'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, {
    title: 'Deck',
    html: `<!doctype html><html lang="en"><title>Deck</title><main><h1 id="slide">Slide 1</h1></main>
      <script>let n = 1; addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') document.getElementById('slide').textContent = 'Slide ' + ++n })</script></html>`,
  })
  await page.goto(`/a/${slug}`)
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'Slide 1' })).toBeVisible()

  await page.getByRole('button', { name: 'Full screen' }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('viewer-frame')
  await page.keyboard.press('ArrowRight')
  await expect(frame.getByRole('heading', { name: 'Slide 2' })).toBeVisible()

  await page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible()
})
