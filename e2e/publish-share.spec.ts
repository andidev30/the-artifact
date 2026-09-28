import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { connectAgent, latestMail, publishViaMcp, signUpPersonal, uniqueEmail } from './helpers'

const HTML = '<!doctype html><html><body><h1 id="hello">Signups by week</h1><script>document.body.dataset.ran = "yes"</script></body></html>'

test('publish a page, open it, share it, and open it by link while signed out', async ({ page, browser }) => {
  const email = uniqueEmail('owner')
  const friend = uniqueEmail('friend')
  const title = `Signups ${Date.now()}`

  await signUpPersonal(page, email)
  await expect(page.getByText('No pages yet.')).toBeVisible()

  // An agent publishes through MCP
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title, html: HTML })

  // It shows up in the gallery
  await page.reload()
  const link = page.getByRole('link', { name: new RegExp(title) })
  // The title link covers the whole card; the tags sit beside it inside the card
  const card = page.locator('.page-card', { has: link })
  await expect(link).toBeVisible()
  await expect(card).toContainText('Restricted')
  await expect(card).toContainText('e2e-agent')
  await link.click()

  // The viewer renders it in a sandboxed frame
  await expect(page).toHaveURL(new RegExp(`/a/${slug}$`))
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'Signups by week' })).toBeVisible()
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes')
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('sandbox', /allow-scripts/)
  await expect(page.locator('iframe.viewer-frame')).not.toHaveAttribute('sandbox', /allow-same-origin/)
  // Loaded from its own URL (not srcdoc), so a page's files resolve by relative paths; signed in, with the comment helper
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('src', `/api/artifacts/${slug}/v/1/~comments/`)
  await expect(page.locator('iframe.viewer-frame')).not.toHaveAttribute('srcdoc', /.*/)

  // Share with a person
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: `Share “${title}”` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`${email} (you)`)).toBeVisible()
  await dialog.getByLabel('Add people by email').fill(friend)
  await dialog.getByPlaceholder('Message (optional)').fill('Have a look')
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText(`Shared with ${friend}. They will get an email with the link.`)
  await expect(dialog.getByText('invited, not signed in yet')).toBeVisible()

  // They get an email with the link
  const mail = await latestMail(page.request, friend, /shared/)
  expect(mail).toContain(`/a/${slug}`)
  expect(mail).toContain('Have a look')

  // Change their role, then open general access to anyone with the link
  await dialog.getByLabel(`Role for ${friend}`).selectOption('editor')
  await expect(dialog.getByLabel(`Role for ${friend}`)).toHaveValue('editor')
  await dialog.getByLabel('Who can open with the link').selectOption('link')
  await expect(dialog.getByText('Anyone on the internet with the link can view.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.viewer-badge')).toHaveText('Anyone with the link')

  // Someone signed out can open it now
  const anonymous = await browser.newContext()
  const anonPage = await anonymous.newPage()
  await anonPage.goto(`/a/${slug}`)
  await expect(anonPage.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await expect(anonPage.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Signups by week' })).toBeVisible()
  await expect(anonPage.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await expect(anonPage.getByRole('button', { name: 'Share' })).toHaveCount(0)
  await anonymous.close()
})

test('a restricted page is unavailable to someone signed out, with a way to log in', async ({ page, browser }) => {
  await signUpPersonal(page, uniqueEmail('private'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Private notes', html: '<h1>secret</h1>' })

  const anonymous = await browser.newContext()
  const anonPage = await anonymous.newPage()
  await anonPage.goto(`/a/${slug}`)
  await expect(anonPage.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  await expect(anonPage.locator('iframe')).toHaveCount(0)
  const login = anonPage.getByRole('link', { name: 'Log in to open it' })
  await expect(login).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/a/${slug}`)}`)
  await login.click()
  await expect(anonPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await anonymous.close()
})

test('a signed-in stranger sees who they are signed in as', async ({ page, browser }) => {
  await signUpPersonal(page, uniqueEmail('author'))
  const token = await connectAgent(page)
  const slug = await publishViaMcp(page.request, token, { title: 'Private notes', html: '<h1>secret</h1>' })

  const strangerEmail = uniqueEmail('stranger')
  const stranger = await browser.newContext()
  const strangerPage = await stranger.newPage()
  await signUpPersonal(strangerPage, strangerEmail)
  await strangerPage.goto(`/a/${slug}`)
  await expect(strangerPage.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  await expect(strangerPage.getByText(`You're signed in as ${strangerEmail}`)).toBeVisible()
  await expect(strangerPage.getByRole('button', { name: 'Switch account' })).toBeVisible()
  await stranger.close()
})

// A 4x4 red PNG
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'

test('a restricted multi-file page loads its CSS, JS and images in the viewer and in the history', async ({ page }) => {
  await signUpPersonal(page, uniqueEmail('site'))
  const token = await connectAgent(page)
  const html =
    '<!doctype html><link rel="stylesheet" href="css/site.css"><h1>Multi-file</h1><img id="dot" src="img/dot.png" width="40" height="40"><p id="data">…</p><script src="js/app.js"></script>'
  const files = [
    { path: 'css/site.css', content: 'body { background: rgb(10, 120, 90) }' },
    {
      path: 'js/app.js',
      content:
        'document.body.dataset.ran = "yes"; fetch("data.json").then((r) => r.json()).then((d) => { document.getElementById("data").textContent = d.word })',
    },
    { path: 'data.json', content: '{"word":"loaded"}' },
    { path: 'img/dot.png', content: RED_PNG, encoding: 'base64' as const },
  ]
  const slug = await publishViaMcp(page.request, token, { title: 'Site v1', html, files })
  await publishViaMcp(page.request, token, { title: 'Site v2', html: '<h1>Second version</h1>', artifact_id: slug })

  await page.goto(`/a/${slug}`)
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'Second version' })).toBeVisible()

  // Version 1 from the history: an older, restricted version, so every file needs the owner's access
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: /Version 1/ }).click()
  await expect(page.getByText('Viewing version 1')).toBeVisible()
  await expect(frame.getByRole('heading', { name: 'Multi-file' })).toBeVisible()
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes')
  await expect(frame.locator('#data')).toHaveText('loaded')
  await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(10, 120, 90)')
  await expect.poll(() => frame.locator('#dot').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(4)

  // Download saves the version being viewed, with all its files, as a zip
  await page.getByRole('button', { name: 'More actions' }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('site-v2-v1.zip')
  const zip = await readFile((await download.path())!)
  expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04')
  for (const name of ['index.html', 'css/site.css', 'js/app.js', 'data.json', 'img/dot.png']) expect(zip.includes(name)).toBe(true)

  // Restoring brings the files back as version 3
  await page.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.getByText(/Version 3, updated/)).toBeVisible()
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('src', `/api/artifacts/${slug}/v/3/~comments/`)
  await expect(frame.locator('#data')).toHaveText('loaded')
})
