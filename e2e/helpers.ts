import { createHash, randomBytes } from 'node:crypto'
import { expect, type APIRequestContext, type Page } from '@playwright/test'

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025'

// Unique per run and per test, so old mail in Mailpit never matches
export function uniqueEmail(label: string) {
  return `e2e-${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@example.com`
}

type MailSummary = { ID: string; Subject: string }

// Waits for the newest email to an address and returns its plain text
export async function latestMail(request: APIRequestContext, to: string, subject?: RegExp): Promise<string> {
  let id: string | undefined
  await expect
    .poll(
      async () => {
        const res = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
        const { messages } = (await res.json()) as { messages: MailSummary[] }
        id = messages.find((m) => !subject || subject.test(m.Subject))?.ID
        return id
      },
      { message: `email to ${to}`, timeout: 10_000 },
    )
    .toBeTruthy()
  const msg = await (await request.get(`${MAILPIT}/api/v1/message/${id}`)).json()
  return msg.Text as string
}

export async function signInLink(request: APIRequestContext, email: string) {
  const text = await latestMail(request, email, /sign-in link|creating your account/i)
  const link = text.match(/https?:\/\/\S+\/auth\/confirm\?\S+/)?.[0]
  expect(link, 'sign-in link in email').toBeTruthy()
  return link!
}

// Sign up through the UI with a magic link read from Mailpit; ends on /onboarding
export async function signUp(page: Page, email: string, path = '/signup') {
  await page.goto(path)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-up link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await openSignInLink(page, await signInLink(page.request, email), email)
  await expect(page).toHaveURL(/\/onboarding/)
}

// Opening the link only shows a confirmation page; pressing Continue signs in
export async function openSignInLink(page: Page, link: string, email: string) {
  await page.goto(link)
  await page.getByRole('button', { name: `Continue as ${email}` }).click()
}

export async function signUpPersonal(page: Page, email: string) {
  await signUp(page, email)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to your pages' }).click()
  await expect(page).toHaveURL(/\/app$/)
}

// What an MCP client does: register, authorize, get consent from the signed-in browser, exchange the code.
// page.request shares the browser's cookies and goes through the web app's proxy.
export async function connectAgent(page: Page, organizationId: string | null = null) {
  const request = page.request
  const redirectUri = 'http://127.0.0.1:43999/callback'
  const client = await (await request.post('/oauth/register', { data: { client_name: 'e2e-agent', redirect_uris: [redirectUri] } })).json()

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = await request.get('/oauth/authorize', {
    params: { response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' },
    maxRedirects: 0,
  })
  const requestId = new URL(authorize.headers().location).searchParams.get('request')!

  const approved = await (await request.post(`/api/oauth/requests/${requestId}/approve`, { data: { organizationId } })).json()
  const code = new URL(approved.redirect).searchParams.get('code')!
  const tokens = await (
    await request.post('/oauth/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri } })
  ).json()
  expect(tokens.access_token).toBeTruthy()
  return tokens.access_token as string
}

type PublishArgs = {
  title: string
  html: string
  visibility?: string
  artifact_id?: string
  folder?: string
  files?: { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
}

export async function publishViaMcp(request: APIRequestContext, token: string, args: PublishArgs) {
  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'publish_artifact', arguments: args } },
  })
  expect(res.status()).toBe(200)
  const text = (await res.json()).result.content[0].text as string
  const slug = text.match(/artifact_id: ([a-z0-9]+)/)?.[1]
  expect(slug, text).toBeTruthy()
  return slug!
}
