import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { forgetSignInLinks } from '../apps/api/test/e2e-db.ts'
import { expectAccessible } from './axe'
import { fromApp, openSignInLink, signUpPersonal, uniqueEmail } from './helpers'

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025'

// Chrome's virtual authenticator (DevTools protocol) stands in for Touch ID or a security key: it
// makes discoverable passkeys and answers every request as if the person unlocked it
async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

// RFC 6238 with the settings every authenticator app uses, like the app on a phone would
function base32Decode(text: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const stepNow = () => Math.floor(Date.now() / 30_000)

function totp(secret: Buffer, step: number) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

async function logOut(page: Page) {
  await page.request.post('/api/auth/logout', { headers: fromApp(page) })
  await page.context().clearCookies()
}

async function newestMailId(page: Page, email: string): Promise<string | undefined> {
  const res = await page.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
  return ((await res.json()) as { messages: { ID: string }[] }).messages[0]?.ID
}

// The email link, then the second-factor page
async function emailLinkSignIn(page: Page, email: string) {
  await forgetSignInLinks(email)
  const before = await newestMailId(page, email)
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  let id: string | undefined
  await expect
    .poll(
      async () => {
        id = await newestMailId(page, email)
        return id !== before
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  const text = (await (await page.request.get(`${MAILPIT}/api/v1/message/${id}`)).json()).Text as string
  const link = text.match(/https?:\/\/\S+\/auth\/confirm\?\S+/)?.[0]
  expect(link, 'sign-in link in email').toBeTruthy()
  await openSignInLink(page, link!, email)
  await expect(page).toHaveURL(/\/login\/two-factor$/)
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible()
}

test('add a passkey, sign in with it alone, and use it as the second factor', async ({ page }) => {
  await addVirtualAuthenticator(page)
  const email = uniqueEmail('passkey')
  await signUpPersonal(page, email)

  await page.goto('/settings#security')
  const section = page.locator('section#security')
  await expect(section.getByRole('heading', { name: 'Sign-in security' })).toBeVisible()
  await section.getByLabel('Passkey name').fill('Test laptop')
  await section.getByRole('button', { name: 'Add a passkey' }).click()

  // The first factor comes with recovery codes, shown once
  const codes = section.locator('.security-codes')
  await expect(codes).toContainText('Save your recovery codes now.')
  await expect(codes.locator('code')).toHaveCount(10)
  await codes.getByRole('button', { name: 'I saved them' }).click()
  await expect(codes).toHaveCount(0)
  const row = section.getByRole('listitem').filter({ hasText: 'Test laptop' })
  await expect(row).toContainText('Not used yet')
  await expect(section).toContainText('10 of 10 left.')
  await expectAccessible(page, 'sign-in security with a passkey')

  // Without an email address
  await logOut(page)
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page).toHaveURL(/\/app$/)

  // An email link is one factor; the passkey is the second
  await logOut(page)
  await emailLinkSignIn(page, email)
  await expectAccessible(page, 'two-factor step, passkey')
  await page.getByRole('button', { name: 'Use your passkey' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await page.goto('/settings#sessions')
  const sessions = page.locator('section#sessions')
  await expect(sessions.getByRole('listitem').filter({ hasText: 'This device' })).toContainText('Chrome')
  await expect(page.locator('section#security').getByRole('listitem').filter({ hasText: 'Test laptop' })).toContainText('Last used')
})

test('set up an authenticator app, then sign in with a code and with a recovery code', async ({ page }) => {
  const email = uniqueEmail('totp')
  await signUpPersonal(page, email)

  await page.goto('/settings#security')
  const section = page.locator('section#security')
  await section.getByRole('button', { name: 'Set up' }).click()
  await expect(section.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible()
  const key = (await section.locator('.security-totp .command code').textContent()) ?? ''
  expect(key).toMatch(/^[A-Z2-7 ]+$/)
  const secret = base32Decode(key)

  const enrolled = stepNow()
  await section.getByLabel('Enter the 6-digit code the app shows').fill(totp(secret, enrolled))
  await section.getByRole('button', { name: 'Turn on' }).click()
  const codes = section.locator('.security-codes')
  await expect(codes.locator('code')).toHaveCount(10)
  const recovery = ((await codes.locator('code').first().textContent()) ?? '').trim()
  expect(recovery).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
  await expectAccessible(page, 'recovery codes')
  await codes.getByRole('button', { name: 'I saved them' }).click()
  await expect(section).toContainText('On. Signing in asks for a 6-digit code')

  await logOut(page)
  await emailLinkSignIn(page, email)
  await expectAccessible(page, 'two-factor step')
  // The enrolment code can't be used again, so this is the next step's code (one step of drift is allowed)
  await page.getByLabel('6-digit code').fill(totp(secret, Math.max(stepNow(), enrolled + 1)))
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await logOut(page)
  await emailLinkSignIn(page, email)
  await page.getByRole('button', { name: 'Use a recovery code' }).click()
  await expect(page.getByLabel('Recovery code')).toBeVisible()
  await expectAccessible(page, 'two-factor step, recovery code')
  await page.getByLabel('Recovery code').fill(recovery)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await page.goto('/settings#security')
  await expect(page.locator('section#security')).toContainText('9 of 10 left.')
})
