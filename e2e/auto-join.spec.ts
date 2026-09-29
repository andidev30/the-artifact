import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createHostedOrganization, grantInstanceAdmin } from '../apps/api/test/e2e-db.ts'
import { openSignInLink, signInLink, signUpPersonal, uniqueEmail } from './helpers'

// The setting is one per server, so this is the only spec that saves it, with a domain of its own
test('an instance admin names a domain, and someone who signs up there joins the organization', async ({ page, browser }) => {
  const id = randomBytes(4).toString('hex')
  const domain = `aj-${id}.test`
  // Starts with a digit so it sorts among the first organizations in the list
  const name = `0 Joined by domain ${id}`
  const adminEmail = uniqueEmail('auto-join-admin')
  await signUpPersonal(page, adminEmail)
  await grantInstanceAdmin(adminEmail)
  const org = await createHostedOrganization(adminEmail, name, `e2e-aj-${id}`)

  await page.goto('/admin#auto-join')
  const section = page.locator('#auto-join')
  await section.getByLabel('Organization').selectOption(org.id)
  await section.getByLabel('Email domains').fill(domain)
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText(`Saved. People at these domains join ${name} when they next sign in.`)).toBeVisible()

  const other = await browser.newContext()
  const joiner = await other.newPage()
  const email = `e2e-joiner-${id}@${domain}`
  await joiner.goto('/signup')
  await joiner.getByLabel('Email').fill(email)
  await joiner.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(joiner.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(joiner, await signInLink(joiner.request, email), email)

  // Joining counts as setting up a workspace, and with nothing chosen yet the organization opens
  await expect(joiner).toHaveURL(/\/app$/)
  const notice = joiner.getByRole('region', { name: 'Organizations you joined' })
  await expect(notice).toContainText(`You joined ${name} because your address is on ${domain}.`)
  await expect(joiner.getByText(`Everything published to ${name}. Your role: Member.`)).toBeVisible()
  await notice.getByRole('button', { name: `Dismiss the notice about ${name}` }).press('Enter')
  await expect(notice).toHaveCount(0)
  await joiner.reload()
  await expect(joiner.getByRole('heading', { level: 1, name: 'Pages' })).toBeVisible()
  await expect(joiner.getByRole('region', { name: 'Organizations you joined' })).toHaveCount(0)
  await other.close()

  await section.getByLabel('Organization').selectOption('')
  await section.getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText('Saved. Nobody joins automatically.')).toBeVisible()
})
