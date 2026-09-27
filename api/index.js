// The hosted service on Vercel: every API, MCP and OAuth path is rewritten here (vercel.json), and
// the built web app is served as static files. Imports the tsc output, which the build step writes.
import { readFileSync } from 'node:fs'
import { app } from '../apps/api/dist/app.js'
import { servePagePreviews } from '../apps/api/dist/previews.js'

// Page links (/a/<slug>) come here too, so their shell carries link preview tags. The web build runs
// first and vercel.json bundles its index.html with this function.
servePagePreviews(app, readFileSync(new URL('../apps/web/dist/index.html', import.meta.url), 'utf8'))

const handler = (request) => app.fetch(request)

export const GET = handler
export const HEAD = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
