// The hosted service on Vercel: every API, MCP and OAuth path is rewritten here (vercel.json), and
// the built web app is served as static files. Imports the tsc output, which the build step writes.
import { app } from '../apps/api/dist/app.js'

const handler = (request) => app.fetch(request)

export const GET = handler
export const HEAD = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
