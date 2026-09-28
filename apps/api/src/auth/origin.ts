import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { env } from '../env.js'

// Requests that change something under /api come from the web app itself. The session cookie is
// SameSite=Lax, which keeps it off other sites' requests but still lets a form on another site
// post to a sign-in route and have the response's cookie stored; and a sibling host on the same
// site (CONTENT_ORIGIN, for one) counts as same-site. So every POST, PUT, PATCH and DELETE here
// must say where it came from:
// - Sec-Fetch-Site, which browsers set and pages can't, must be same-origin (or none, for
//   something the person did themselves, like reloading);
// - without it (older browsers, scripts), Origin must be APP_URL's origin;
// - with neither, the request is refused: every browser sends one of them on these methods.
// Bearer tokens are exempt: a browser only sends one when a page's own script sets it, and other
// sites can't do that here without CORS, which the API never allows.
//
// A body that says what it is must be JSON too. HTML forms can only send url-encoded, multipart
// or plain text bodies, and a script on another site can't send JSON without asking first (CORS).

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Called from other sites by design: the IdP posts the SAML response to the ACS from its own page
const CROSS_SITE_PATHS = new Set(['/api/auth/sso/saml/acs'])

export function fromThisApp(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin' || site === 'none'
  const origin = c.req.header('origin')
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(env.appUrl).origin
  } catch {
    return false
  }
}

// Forms always send a Content-Type; a request without a body usually has none
function notJson(c: Context): boolean {
  const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
  if (!type) return false
  return type !== 'application/json' && !(type.startsWith('application/') && type.endsWith('+json'))
}

export const sameOriginWrites = createMiddleware(async (c, next) => {
  if (!WRITES.has(c.req.method) || CROSS_SITE_PATHS.has(c.req.path)) return next()
  if (/^bearer\s/i.test(c.req.header('authorization') ?? '')) return next()
  if (!fromThisApp(c)) return c.json({ error: 'This request did not come from this app. Reload the page and try again.' }, 403)
  if (notJson(c)) return c.json({ error: 'Send the request as JSON.' }, 415)
  await next()
})
