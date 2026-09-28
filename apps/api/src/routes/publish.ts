import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { artifactUrl, parseArtifactRef, publish, PublishError } from '../artifacts.js'
import { db, schema } from '../db/index.js'
import type { Visibility } from '../db/schema.js'
import { ENTRY_PATH, MAX_TOTAL_BYTES, type FileInput } from '../files.js'
import { hit, rule, tooManyRequests, waitText, windowText } from '../limits.js'
import { authenticateBearer, type McpAuth } from '../oauth/server.js'

// POST /api/publish: publishing without an MCP client, for CI jobs and scripts (and the CLI that
// builds on it), with an access token from settings as the bearer token. Takes what publish_artifact
// takes, as JSON or as multipart form data, goes through the same publish, quotas and "publish" limit,
// and answers with the link. docs/publishing.md documents it; keep it stable.

const VISIBILITIES = new Set<Visibility>(['private', 'organization', 'link'])
const FIELDS = new Set(['title', 'artifact_id', 'visibility', 'folder'])

// Base64 in JSON makes files a third larger, plus room for the rest of the body
const MAX_BODY = Math.ceil((MAX_TOTAL_BYTES * 4) / 3) + 1024 * 1024

type Input = { title: string; html: string; files: FileInput[]; artifact_id?: string; visibility?: Visibility; folder?: string }

class InputError extends Error {
  field?: string
  constructor(message: string, field?: string) {
    super(message)
    this.field = field
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new InputError(`${field} must be text.`, field)
  return value
}

function checkInput(raw: { title?: unknown; html?: unknown; files: FileInput[]; artifact_id?: unknown; visibility?: unknown; folder?: unknown }): Input {
  const title = optionalString(raw.title, 'title')
  if (!title?.trim()) throw new InputError('Give the page a title.', 'title')
  if (typeof raw.html !== 'string' || !raw.html.trim()) throw new InputError('Send the page itself as html, or as a file part named index.html.', 'html')
  const visibility = optionalString(raw.visibility, 'visibility')
  if (visibility !== undefined && !VISIBILITIES.has(visibility as Visibility))
    throw new InputError('visibility is one of private, organization or link.', 'visibility')
  return {
    title,
    html: raw.html,
    files: raw.files,
    artifact_id: optionalString(raw.artifact_id, 'artifact_id') || undefined,
    visibility: visibility as Visibility | undefined,
    folder: optionalString(raw.folder, 'folder'),
  }
}

// { title, html, files: [{ path, content, encoding }], artifact_id, visibility, folder }, as in publish_artifact
async function fromJson(c: Context): Promise<Input> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Send a JSON object.')
  const files = body.files ?? []
  if (!Array.isArray(files) || files.some((f) => !f || typeof f !== 'object')) {
    throw new InputError('files is a list of { path, content, encoding }.', 'files')
  }
  return checkInput({ ...body, files: files as FileInput[] })
}

// Fields title, artifact_id, visibility and folder, and one file part per file of the page, named by
// its path: index.html for the page itself, css/site.css, img/logo.png... That is what curl sends for
// -F 'index.html=@report/index.html' -F 'img/logo.png=@report/img/logo.png'.
async function fromForm(c: Context): Promise<Input> {
  const form = await c.req.parseBody({ all: true }).catch(() => null)
  if (!form) throw new InputError('The form data could not be read.')
  const fields: Record<string, string> = {}
  let html: string | undefined
  const files: FileInput[] = []
  for (const [name, value] of Object.entries(form)) {
    if (Array.isArray(value)) throw new InputError(`"${name}" is in the form more than once.`, name)
    if (name === ENTRY_PATH || name === 'html') {
      if (html !== undefined) throw new InputError('Send the page itself once, as index.html.', 'html')
      html = typeof value === 'string' ? value : await value.text()
    } else if (typeof value === 'string') {
      if (!FIELDS.has(name)) throw new InputError(`"${name}" isn't a field this takes. Send files as file parts, named by their path.`, name)
      fields[name] = value
    } else {
      files.push({ path: name, content: Buffer.from(await value.arrayBuffer()).toString('base64'), encoding: 'base64' })
    }
  }
  return checkInput({ ...fields, html, files })
}

function unauthorized(c: Context, sent: boolean) {
  return c.json(
    { error: sent ? 'This access token is not valid. It may have expired or been revoked.' : 'Send an access token as Authorization: Bearer <token>.' },
    401,
    { 'WWW-Authenticate': `Bearer realm="The Artifact"${sent ? ', error="invalid_token"' : ''}` },
  )
}

async function folderName(folderId: string | null) {
  if (!folderId) return null
  const [row] = await db.select({ name: schema.folders.name }).from(schema.folders).where(eq(schema.folders.id, folderId))
  return row?.name ?? null
}

export const publishApi = new Hono()

publishApi.post(
  '/',
  bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.json({ error: `The request is too large. A page and its files can be up to ${MAX_TOTAL_BYTES / 1024 / 1024} MB.` }, 413),
  }),
  async (c) => {
    const header = c.req.header('authorization')
    const auth: McpAuth | null = await authenticateBearer(header)
    if (!auth) return unauthorized(c, Boolean(header))

    const type = c.req.header('content-type') ?? ''
    let input: Input
    try {
      if (type.includes('application/json')) input = await fromJson(c)
      else if (type.includes('multipart/form-data')) input = await fromForm(c)
      else return c.json({ error: 'Send JSON (Content-Type: application/json) or multipart/form-data.' }, 415)
    } catch (err) {
      if (err instanceof InputError) return c.json({ error: err.message, ...(err.field ? { field: err.field } : {}) }, 400)
      throw err
    }

    const wait = await hit('publish', auth.userId)
    if (wait) {
      const r = rule('publish')!
      return tooManyRequests(
        c,
        `This account is past this server's limit of ${r.max} new pages and versions per ${windowText(r.seconds)}. Try again in ${waitText(wait)}.`,
        wait,
      )
    }

    try {
      const artifact = await publish({
        userId: auth.userId,
        email: auth.email,
        organizationId: auth.organizationId,
        clientName: auth.clientName,
        title: input.title,
        html: input.html,
        files: input.files,
        slug: input.artifact_id ? parseArtifactRef(input.artifact_id) : undefined,
        visibility: input.visibility,
        folder: input.folder,
      })
      return c.json(
        {
          id: artifact.slug,
          url: artifactUrl(artifact.slug),
          title: artifact.title,
          version: artifact.currentVersion,
          visibility: artifact.visibility,
          folder: await folderName(artifact.folderId),
        },
        input.artifact_id ? 200 : 201,
      )
    } catch (err) {
      if (err instanceof PublishError) return c.json({ error: err.message }, 400)
      throw err
    }
  },
)

// GET /api/whoami: who a bearer token acts for and in which workspace, so the CLI and scripts can
// check a token before relying on it. Bearer tokens only, like POST /api/publish.
export const whoamiApi = new Hono()

whoamiApi.get('/', async (c) => {
  const header = c.req.header('authorization')
  const auth = await authenticateBearer(header)
  if (!auth) return unauthorized(c, Boolean(header))
  const [user] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.userId))
  const [org] = auth.organizationId
    ? await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, auth.organizationId))
    : []
  return c.json({
    email: auth.email,
    name: user?.name ?? null,
    workspace: { id: auth.organizationId, name: org?.name ?? 'Personal' },
    client: auth.clientName,
  })
})
