import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

// Paths the API owns; everything else is the single-page app
const API_PREFIXES = ['/api/', '/mcp', '/oauth/', '/.well-known/']

// Serves the built web app next to the API, so a self-hosted install is one process on one port
export function mountWeb(app: Hono<any>, dir: string) {
  const index = readFileSync(join(dir, 'index.html'), 'utf8')

  // Hashed build assets never change; the HTML shell always revalidates
  app.use('/assets/*', async (c, next) => {
    await next()
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable')
  })
  app.use('/*', serveStatic({ root: dir }))

  app.get('*', (c) => {
    // Missing API paths and build files are real 404s, not the app shell
    if (API_PREFIXES.some((p) => c.req.path.startsWith(p)) || c.req.path.startsWith('/assets/')) return c.notFound()
    c.header('Cache-Control', 'no-cache')
    return c.html(index)
  })
}
