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

// Whether keyboard focus fell back to the document, as it does when the focused control is removed
export const focusLost = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null)

// Headers for page.request calls that change something with the browser's session: it isn't a browser,
// so it sends no Origin by itself, and the API refuses changes from anywhere but the app
export function fromApp(page: Page) {
  return { origin: new URL(page.url()).origin }
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

  const approved = await (await request.post(`/api/oauth/requests/${requestId}/approve`, { headers: fromApp(page), data: { organizationId } })).json()
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

type RetentionState = { keepDays: number | null; keepVersions: number | null; license: 'none' | 'active' | 'grace' | 'expired' }

// Version retention needs an Enterprise license, which the e2e servers can't have (their code knows
// no signing key), so its settings are shown by answering /api/config as a self-hosted install and
// the retention API the way a licensed or unlicensed server would. The server's own rules are
// covered by apps/api/test/integration/retention.test.ts. Returns the policies saved.
export async function mockRetention(page: Page, initial: RetentionState, preview = { versions: 12, pages: 3 }) {
  const state = { ...initial, updatedAt: null as string | null }
  const body = () => ({ ...state, applied: (state.keepDays !== null || state.keepVersions !== null) && ['active', 'grace'].includes(state.license) })
  const saves: unknown[] = []
  await page.route('**/api/config', async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), selfHosted: true } }))
  await page.route(/\/api\/organizations\/[^/]+\/retention(\/preview)?(\?.*)?$/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/preview')) return route.fulfill({ json: preview })
    if (route.request().method() === 'PUT') {
      const json = route.request().postDataJSON() as { keepDays: number | null; keepVersions: number | null }
      saves.push(json)
      Object.assign(state, json, { updatedAt: new Date().toISOString() })
    }
    return route.fulfill({ json: body() })
  })
  return saves
}

// The audit log is an Enterprise feature of self-hosted installs, which the e2e servers can't turn on
// (license keys only verify against keys in the code), so its screen is shown by answering /api/config
// and the audit log API the way a licensed self-hosted server would. `licensed: false` answers like a
// server without a license. Returns the audit log requests the page made.
export async function mockAuditLog(page: Page, { licensed = true, events = 60 } = {}) {
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch()
    await route.fulfill({ json: { ...(await res.json()), selfHosted: true } })
  })
  const kinds = [
    { action: 'sign_in.succeeded', target: null, details: { method: 'password' } },
    { action: 'page.visibility_changed', target: { type: 'page', id: 'abc', label: 'Launch plan' }, details: { from: 'private', to: 'link' } },
    { action: 'member.role_changed', target: { type: 'member', id: 'm1', label: 'bo@example.com' }, details: { from: 'member', to: 'admin' } },
    { action: 'sign_in.failed', target: null, details: { reason: 'wrong password' } },
  ]
  const all = Array.from({ length: events }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    at: new Date(Date.UTC(2026, 8, 28, 12) - i * 3_600_000).toISOString(),
    actor: { id: null, email: i % 2 ? 'ana@example.com' : 'owner@example.com' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    ...kinds[i % kinds.length],
  }))
  const asked: URL[] = []
  await page.route(
    (url) => /\/api\/organizations\/[^/]+\/audit-log$/.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url())
      asked.push(url)
      if (!licensed) {
        return route.fulfill({
          status: 403,
          json: { error: 'This needs an Enterprise license. An instance admin can add one under Server admin.', code: 'enterprise_required' },
        })
      }
      const action = url.searchParams.get('action')
      const matching = all.filter((e) => !action || e.action === action)
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const next = start + 50 < matching.length ? String(start + 50) : null
      await route.fulfill({ json: { events: matching.slice(start, start + 50), next, actions: [], retentionDays: 365 } })
    },
  )
  return asked
}

export const SSO_CONNECTION = {
  id: '0b5e8a52-8f3c-4d59-9a53-5f0f3f7d2c11',
  protocol: 'oidc',
  name: 'Okta',
  enabled: true,
  issuer: 'https://acme.okta.com',
  clientId: 'the-artifact',
  hasClientSecret: true,
  trustEmail: false,
  saml: null,
  allowedDomains: ['acme.example'],
  required: true,
  organizationId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

// Single sign-on needs an Enterprise license on a self-hosted install, which the e2e servers don't
// have (license keys are only signed by the hosted service), so its screens are shown by answering
// the API the way a licensed install would. What the API does is in apps/api/test/integration/sso.test.ts,
// saml.test.ts and scim.test.ts.
export async function licensedSso(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), selfHosted: true, sso: [{ id: SSO_CONNECTION.id, name: 'Okta' }] } })
  })
  await page.route('**/api/admin/sso', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { ...SSO_CONNECTION, id: '7d0c1f4e-2b8a-4c3d-9e6f-1a2b3c4d5e6f', name: 'Keycloak', required: false } })
      : route.fulfill({
          json: {
            redirectUri: 'http://localhost:5177/api/auth/sso/oidc/callback',
            saml: { entityId: 'http://localhost:5177/api/auth/sso/saml/metadata', acsUrl: 'http://localhost:5177/api/auth/sso/saml/acs' },
            connections: [SSO_CONNECTION],
            organizations: [],
          },
        }),
  )
  const scim = {
    baseUrl: 'http://localhost:5177/scim/v2',
    organizations: [],
    tokens: [
      {
        id: '1d6c3b0e-2a3f-4e5d-9c1b-7a8e9f0a1b2c',
        name: 'Okta',
        organizationId: null,
        organizationName: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        lastUsedAt: null,
      },
    ],
  }
  await page.route('**/api/admin/scim', (route) => route.fulfill({ json: scim }))
  await page.route('**/api/admin/scim/tokens', (route) => route.fulfill({ status: 201, json: { ...scim, token: 'scim_e2e-token-shown-once' } }))
  await page.route('**/api/admin/license', (route) =>
    route.fulfill({
      json: {
        status: 'active',
        invalid: null,
        license: {
          id: '6f1c0b8e-4a8f-4f8e-9d7a-2b1f1c0e5a11',
          customer: 'Acme Inc',
          email: 'it@acme.example',
          seats: 50,
          issuedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          graceEndsAt: '2099-01-15T00:00:00.000Z',
        },
        seatsInUse: 3,
      },
    }),
  )
  await page.route('**/api/admin/sso/test-result', (route) =>
    route.fulfill({
      json: { connectionId: SSO_CONNECTION.id, ok: true, subject: '00u1abcd', email: 'ada@acme.example', emailVerified: true, name: 'Ada', accepted: true },
    }),
  )
}
