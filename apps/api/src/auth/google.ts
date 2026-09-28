import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { env, isProduction } from '../env.js'
import { log } from '../log.js'
import { randomToken } from './session.js'
import { continueSignIn } from './twofactor.js'
import { afterSignInUrl, findOrCreateUser, safeNext, signInErrorUrl, SignupClosedError } from './users.js'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

// Short-lived cookies that carry the OAuth round trip
const FLOW_COOKIE = { path: '/api/auth/google', httpOnly: true, secure: isProduction, sameSite: 'Lax', maxAge: 600 } as const

const redirectUri = `${env.appUrl}/api/auth/google/callback`

type GoogleUser = {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

export const google = new Hono()

google.get('/', (c) => {
  if (!env.google.clientId) return c.redirect(signInErrorUrl('google_not_configured'))

  const state = randomToken()
  const verifier = randomToken()
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  setCookie(c, 'google_state', state, FLOW_COOKIE)
  setCookie(c, 'google_verifier', verifier, FLOW_COOKIE)
  const plan = c.req.query('plan')
  if (plan) setCookie(c, 'google_plan', plan, FLOW_COOKIE)
  const next = safeNext(c.req.query('next'))
  if (next) setCookie(c, 'google_next', next, FLOW_COOKIE)

  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return c.redirect(url.toString())
})

google.get('/callback', async (c) => {
  const state = getCookie(c, 'google_state')
  const verifier = getCookie(c, 'google_verifier')
  const plan = getCookie(c, 'google_plan')
  const next = getCookie(c, 'google_next')
  for (const name of ['google_state', 'google_verifier', 'google_plan', 'google_next']) {
    deleteCookie(c, name, { path: FLOW_COOKIE.path })
  }

  // The person closed the Google screen or denied access
  if (c.req.query('error')) return c.redirect(signInErrorUrl('google_cancelled'))

  const code = c.req.query('code')
  if (!code || !state || !verifier || c.req.query('state') !== state) {
    return c.redirect(signInErrorUrl('google_failed'))
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.google.clientId,
        client_secret: env.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
    })
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
    const { access_token } = (await tokenRes.json()) as { access_token: string }

    const userRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${access_token}` } })
    if (!userRes.ok) throw new Error(`userinfo failed: ${userRes.status}`)
    const profile = (await userRes.json()) as GoogleUser
    if (!profile.email_verified) return c.redirect(signInErrorUrl('google_unverified'))

    const user = await findOrCreateUser({
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
      googleSub: profile.sub,
    })
    return c.redirect(await continueSignIn(c, user, afterSignInUrl(plan, next), 'google'))
  } catch (err) {
    if (err instanceof SignupClosedError) return c.redirect(signInErrorUrl(err.code))
    log.error('Google sign-in failed', { err })
    return c.redirect(signInErrorUrl('google_failed'))
  }
})
