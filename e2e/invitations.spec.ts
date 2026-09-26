import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { signUp, signUpPersonal, uniqueEmail } from './helpers'

test('a new account joins the organization it was invited to from onboarding', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('inv-owner')
  const guestEmail = uniqueEmail('inv-guest')
  const slug = `e2e-${randomBytes(4).toString('hex')}`

  // The owner creates an organization and invites the guest
  await signUpPersonal(page, ownerEmail)
  const created = await page.request.post('/api/organizations', { data: { name: 'Invite Co', slug } })
  expect(created.status()).toBe(201)
  const org = await created.json()
  const invited = await page.request.post(`/api/organizations/${org.id}/invitations`, { data: { email: guestEmail, role: 'member' } })
  expect(invited.status()).toBe(201)

  // The guest signs up without opening the invitation email and sees it on the first step
  const guest = await browser.newContext()
  const guestPage = await guest.newPage()
  await signUp(guestPage, guestEmail)
  await expect(guestPage.getByRole('heading', { name: 'You have an invitation' })).toBeVisible()
  await guestPage.getByRole('button', { name: 'Join Invite Co' }).click()

  await expect(guestPage).toHaveURL(/\/app$/)
  await expect(guestPage.getByText('Everything published to Invite Co. Your role: Member.')).toBeVisible()
  await guest.close()
})
