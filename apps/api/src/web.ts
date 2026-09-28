import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Env, Hono, MiddlewareHandler } from 'hono'
import { env } from './env.js'
import { SHELL_HEADERS, servePagePreviews } from './previews.js'

// Paths the API owns; everything else is the single-page app
const API_PREFIXES = ['/api/', '/mcp', '/oauth/', '/.well-known/']

// A self-hosted install is usually a team's own server: nothing on it is for search engines, not even
// its sign-in page. Chat apps still get the preview of a page shared with anyone who has the link
// (see previews.ts), as on the hosted service, whose rules are apps/web/public/robots.txt.
export const SELF_HOSTED_ROBOTS = `User-agent: *
Disallow: /

User-agent: Slackbot-LinkExpanding
User-agent: Twitterbot
User-agent: facebookexternalhit
User-agent: LinkedInBot
User-agent: Discordbot
User-agent: TelegramBot
User-agent: WhatsApp
Disallow: /
Allow: /a/
Allow: /api/artifacts/*/thumbnails/
Allow: /api/oembed
`

// With an https APP_URL, browsers that have been here once never try plain HTTP again for a year, so
// someone on the network can't strip TLS from a later visit. Not includeSubDomains: other hosts on the
// domain aren't the app's to decide for. Vercel sends a stronger one of its own, which this would replace.
export function strictTransportSecurity(): string | null {
  return env.appUrl.startsWith('https://') && !process.env.VERCEL ? 'max-age=31536000' : null
}

// Serves the built web app next to the API, so a self-hosted install is one process on one port
export function mountWeb<E extends Env>(app: Hono<E>, dir: string) {
  const index = readFileSync(join(dir, 'index.html'), 'utf8')
  const robotsFile = join(dir, 'robots.txt')
  const hostedRobots = existsSync(robotsFile) ? readFileSync(robotsFile, 'utf8') : SELF_HOSTED_ROBOTS

  // Everything from here on is the app itself; the API, page content and embeds are mounted before it
  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SHELL_HEADERS)) c.header(name, value)
    // Also set for every response by app.ts; here too for a web app mounted on its own
    c.header('X-Content-Type-Options', 'nosniff')
    const hsts = strictTransportSecurity()
    if (hsts) c.header('Strict-Transport-Security', hsts)
  })

  app.get('/robots.txt', (c) => c.text(env.selfHosted ? SELF_HOSTED_ROBOTS : hostedRobots, 200, { 'Cache-Control': 'public, max-age=3600' }))

  // Hashed build assets never change; the HTML shell always revalidates
  app.use('/assets/*', async (c, next) => {
    await next()
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable')
  })
  const files = serveStatic({ root: dir })
  // Build files are only read; serveStatic would answer any method with them
  const readOnly: MiddlewareHandler = (c, next) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? files(c, next) : next())
  app.use('/*', readOnly)
  servePagePreviews(app, index)

  app.all('*', (c) => {
    // Missing API paths and build files are real 404s, not the app shell
    if (API_PREFIXES.some((p) => c.req.path.startsWith(p)) || c.req.path.startsWith('/assets/')) return c.notFound()
    // The app's pages are only ever loaded; nothing on these paths takes a POST or a PUT
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method not allowed', 405, { Allow: 'GET, HEAD' })
    c.header('Cache-Control', 'no-cache')
    return c.html(index)
  })
}
