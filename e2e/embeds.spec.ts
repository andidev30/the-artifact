import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { connectAgent, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><h1>Signups by week</h1><script>document.body.dataset.ran = "yes"</script>'

// Another site that embeds pages the way Notion or a wiki would. It runs on 127.0.0.1, a different site
// from localhost, and is a real server rather than a routed response: Chrome's local network access
// checks stop a page it can't place on this machine from framing localhost.
async function thirdPartySite(body: string) {
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wiki`, close: () => server.close() }
}

test('another site embeds a link-shared page, and a restricted one shows only a sign-in card', async ({ page, baseURL }) => {
  await signUpPersonal(page, uniqueEmail('embed'))
  const token = await connectAgent(page)
  const shared = await publishViaMcp(page.request, token, { title: 'Embedded signups', html: HTML, visibility: 'link' })
  const restricted = await publishViaMcp(page.request, token, { title: 'Secret embed', html: '<h1>secret sauce</h1>' })

  // The share dialog offers the embed code only once the page is shared by link
  await page.goto(`/a/${restricted}`)
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: 'Share “Secret embed”' })
  await expect(dialog.getByText('Embedding needs Anyone with the link.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy embed code' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done' }).click()

  await page.goto(`/a/${shared}`)
  await page.getByRole('button', { name: 'Share' }).click()
  const sharedDialog = page.getByRole('dialog', { name: 'Share “Embedded signups”' })
  await expect(sharedDialog.getByRole('button', { name: 'Copy embed code' })).toBeVisible()
  await expect(sharedDialog.locator('.share-embed code')).toHaveText(
    `<iframe src="${baseURL}/e/${shared}" width="100%" height="600" style="border:0" title="Embedded signups" loading="lazy" allowfullscreen></iframe>`,
  )
  await sharedDialog.getByRole('button', { name: 'Done' }).click()

  // The owner is signed in in this browser, and the restricted embed still shows the card
  const site = await thirdPartySite(`<!doctype html><h1>Team wiki</h1>
<iframe id="shared" src="${baseURL}/e/${shared}" width="800" height="400"></iframe>
<iframe id="restricted" src="${baseURL}/e/${restricted}" width="800" height="400"></iframe>`)
  try {
    await page.goto(site.url)

    const embed = page.frameLocator('#shared')
    const content = embed.frameLocator('iframe.page')
    await expect(content.getByRole('heading', { name: 'Signups by week' })).toBeVisible()
    await expect(content.locator('body')).toHaveAttribute('data-ran', 'yes')
    await expect(embed.locator('iframe.page')).not.toHaveAttribute('sandbox', /allow-same-origin/)
    await expect(embed.getByRole('link', { name: 'Open in The Artifact' })).toHaveAttribute('href', `${baseURL}/a/${shared}`)

    const card = page.frameLocator('#restricted')
    await expect(card.getByRole('heading', { name: 'Sign in to view this page' })).toBeVisible()
    await expect(card.getByRole('link', { name: 'Open in The Artifact' })).toHaveAttribute('href', `${baseURL}/a/${restricted}`)
    await expect(card.locator('iframe')).toHaveCount(0)
    await expect(card.locator('body')).not.toContainText('Secret embed')
    await expect(card.locator('body')).not.toContainText('secret sauce')
  } finally {
    site.close()
  }
})

test('after the link is reset, embeds need the new key and the old embed shows the sign-in card', async ({ page, baseURL }) => {
  await signUpPersonal(page, uniqueEmail('embed-reset'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Reset signups', html: HTML, visibility: 'link' })

  await page.goto(`/a/${slug}`)
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: 'Share “Reset signups”' })
  await dialog.getByRole('button', { name: 'Reset link' }).click()
  await dialog.getByRole('button', { name: 'Make a new link' }).click()
  await expect(dialog.getByText('The link was reset. Copy link to share the new one.')).toBeVisible()
  const code = (await dialog.locator('.share-embed code').textContent()) ?? ''
  const key = code.match(/\/e\/[a-z0-9]+\?k=([A-Za-z0-9_-]+)"/)?.[1]
  expect(key, code).toBeTruthy()
  await dialog.getByRole('button', { name: 'Done' }).click()

  const site = await thirdPartySite(`<!doctype html><h1>Team wiki</h1>
<iframe id="fresh" src="${baseURL}/e/${slug}?k=${key}" width="800" height="400"></iframe>
<iframe id="old" src="${baseURL}/e/${slug}" width="800" height="400"></iframe>`)
  try {
    await page.goto(site.url)
    const fresh = page.frameLocator('#fresh')
    await expect(fresh.frameLocator('iframe.page').getByRole('heading', { name: 'Signups by week' })).toBeVisible()
    await expect(fresh.getByRole('link', { name: 'Open in The Artifact' })).toHaveAttribute('href', `${baseURL}/a/${slug}?k=${key}`)
    const old = page.frameLocator('#old')
    await expect(old.getByRole('heading', { name: 'Sign in to view this page' })).toBeVisible()
    await expect(old.locator('body')).not.toContainText('Reset signups')
  } finally {
    site.close()
  }
})
