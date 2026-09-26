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
  const card = page.getByRole('link', { name: new RegExp(title) })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Restricted')
  await expect(card).toContainText('e2e-agent')
  await card.click()

  // The viewer renders it in a sandboxed frame
  await expect(page).toHaveURL(new RegExp(`/a/${slug}$`))
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const frame = page.frameLocator('iframe.viewer-frame')
  await expect(frame.getByRole('heading', { name: 'Signups by week' })).toBeVisible()
  await expect(frame.locator('body')).toHaveAttribute('data-ran', 'yes')
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('sandbox', /allow-scripts/)
  await expect(page.locator('iframe.viewer-frame')).not.toHaveAttribute('sandbox', /allow-same-origin/)

  // Share with a person
  await page.getByRole('button', { name: 'Share' }).click()
  const dialog = page.getByRole('dialog', { name: `Share “${title}”` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(`${email} (you)`)).toBeVisible()
  await dialog.getByLabel('Add people by email').fill(friend)
  await dialog.getByPlaceholder('Message (optional)').fill('Have a look')
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText(`Shared with ${friend}. They will get an email with the link.`)
  await expect(dialog.getByText('invited, no account yet')).toBeVisible()

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
