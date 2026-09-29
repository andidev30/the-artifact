import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createHostedOrganization } from '../apps/api/test/e2e-db.ts'
import { connectAgent, fromApp, publishViaMcp, signUp, signUpPersonal, uniqueEmail } from './helpers'

test('a new account joins the organization it was invited to from onboarding', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('inv-owner')
  const guestEmail = uniqueEmail('inv-guest')
  const slug = `e2e-${randomBytes(4).toString('hex')}`

  // The owner has an organization from before new ones waited for billing, and invites the guest
  await signUpPersonal(page, ownerEmail)
  const org = await createHostedOrganization(ownerEmail, 'Invite Co', slug)
  const invited = await page.request.post(`/api/organizations/${org.id}/invitations`, { headers: fromApp(page), data: { email: guestEmail, role: 'member' } })
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

test('someone sent an organization page before joining joins from the page that isn’t available to them', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('inv-page-owner')
  const guestEmail = uniqueEmail('inv-page-guest')
  const slug = `e2e-${randomBytes(4).toString('hex')}`

  await signUpPersonal(page, ownerEmail)
  const org = await createHostedOrganization(ownerEmail, 'Page Co', slug)
  const token = await connectAgent(page, org.id)
  const pageSlug = await publishViaMcp(page.request, token, { title: 'Team plan', html: '<!doctype html><h1>Team plan</h1>', visibility: 'organization' })
  const invited = await page.request.post(`/api/organizations/${org.id}/invitations`, { headers: fromApp(page), data: { email: guestEmail, role: 'member' } })
  expect(invited.status()).toBe(201)

  const guest = await browser.newContext()
  const guestPage = await guest.newPage()
  await signUpPersonal(guestPage, guestEmail)
  await guestPage.goto(`/a/${pageSlug}`)
  await expect(guestPage.getByRole('heading', { name: "This page isn't available" })).toBeVisible()
  const invitations = guestPage.getByRole('region', { name: 'Invitations' })
  await expect(invitations.getByText('You have an invitation to Page Co.')).toBeVisible()
  // Nothing says the page belongs to the organization
  await expect(guestPage.getByText('Team plan')).toHaveCount(0)

  await invitations.getByRole('button', { name: 'Join Page Co' }).click()
  await expect(guestPage.frameLocator('iframe.viewer-frame').getByRole('heading', { name: 'Team plan' })).toBeVisible()
  await guest.close()
})
