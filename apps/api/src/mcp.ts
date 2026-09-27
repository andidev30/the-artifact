import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  artifactUrl,
  canEdit,
  canView,
  checkTitle,
  describeVisibility,
  findBySlug,
  getFile,
  getVersion,
  listFiles,
  versionHtml,
  listForWorkspace,
  MAX_TITLE_LENGTH,
  parseArtifactRef,
  publish,
  PublishError,
  rename,
  VISIBILITY_LABEL,
} from './artifacts.js'
import { db, schema } from './db/index.js'
import { ALLOWED_EXTENSIONS, checkPath, ENTRY_PATH, isText, MAX_FILE_BYTES, MAX_FILES, MAX_HTML_BYTES, MAX_TOTAL_BYTES } from './files.js'
import { parseEmails, sharePeople, SharingError } from './sharing.js'
import { authenticateBearer, RESOURCE_METADATA_URL, type McpAuth } from './oauth/server.js'

const visibility = z
  .enum(['private', 'organization', 'link'])
  .describe('private (shown as "Restricted"): only you and people it is shared with. organization: everyone in your organization. link: anyone with the link.')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError }
}

// One server per request (stateless), bound to the person and workspace behind the token
function buildServer(auth: McpAuth) {
  const viewer = { id: auth.userId, email: auth.email }
  const server = new McpServer({ name: 'the-artifact', version: '0.1.0' })

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish a page',
      description:
        'Publish an HTML page and get a shareable link. Either one self-contained document (inline CSS and JS; scripts from public CDNs are fine), ' +
        'or a small site: html is the entry (index.html) and files holds the CSS, JS, images, fonts and data it loads by relative paths. ' +
        `Limits: html up to ${MAX_HTML_BYTES / 1024 / 1024} MB, each file up to ${MAX_FILE_BYTES / 1024 / 1024} MB, ${MAX_TOTAL_BYTES / 1024 / 1024} MB and ${MAX_FILES} files in total. ` +
        'To update a page you published before, pass its artifact_id (or its link) and the link stays the same; send every file again, since each version has its own full set.',
      inputSchema: z.object({
        title: z.string().min(1).describe('Short title shown in the gallery and browser tab'),
        html: z.string().min(1).describe('The complete HTML document; for a multi-file page, the entry (index.html)'),
        files: z
          .array(
            z.object({
              path: z.string().describe('Relative path the HTML uses for it, e.g. "style.css" or "img/logo.png"'),
              content: z.string().describe('The file content: text as is, or base64 for binary files'),
              encoding: z.enum(['utf8', 'base64']).optional().describe('utf8 (default) for text files, base64 for images, fonts, audio and other binary files'),
            }),
          )
          .optional()
          .describe(`Files next to the HTML. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}.`),
        artifact_id: z.string().optional().describe('Id or link of an existing page to publish a new version of'),
        visibility: visibility.optional(),
      }),
    },
    async ({ title, html, files, artifact_id, visibility }) => {
      try {
        const artifact = await publish({
          userId: auth.userId,
          email: auth.email,
          organizationId: auth.organizationId,
          clientName: auth.clientName,
          title,
          html,
          files,
          slug: artifact_id ? parseArtifactRef(artifact_id) : undefined,
          visibility,
        })
        const verb = artifact.currentVersion === 1 ? 'Published' : `Published version ${artifact.currentVersion} of`
        return text(
          `${verb} "${artifact.title}".\n` +
            `Link: ${artifactUrl(artifact.slug)}\n` +
            `artifact_id: ${artifact.slug}\n` +
            (files?.length ? `Files: index.html and ${files.length} more.\n` : '') +
            `Visibility: ${describeVisibility(artifact.visibility)}.`,
        )
      } catch (err) {
        if (err instanceof PublishError) return text(err.message, true)
        throw err
      }
    },
  )

  server.registerTool(
    'list_artifacts',
    {
      title: 'List pages',
      description: 'List the most recently updated pages in the connected workspace.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await listForWorkspace(auth.userId, auth.organizationId, 25)
      if (rows.length === 0) return text('No pages yet. Use publish_artifact to publish one.')
      return text(
        rows
          .map(({ artifact: a }) => `- ${a.title} (artifact_id: ${a.slug}, v${a.currentVersion}, ${VISIBILITY_LABEL[a.visibility]}) ${artifactUrl(a.slug)}`)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'get_artifact',
    {
      title: 'Read a page',
      description:
        'Get the current version of a page, for example to edit it and publish a new version: its entry HTML and the list of its other files. ' +
        'Pass path to read one of those files instead.',
      inputSchema: z.object({
        artifact_id: z.string().describe('Id or link of the page'),
        path: z.string().optional().describe('A file of the page to read, e.g. "style.css"; omit for the entry HTML'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ artifact_id, path }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canView(artifact, viewer))) return text(`No page you can open has the id "${artifact_id}".`, true)
      const current = await getVersion(artifact, artifact.currentVersion)
      if (!current) return text(`No page you can open has the id "${artifact_id}".`, true)

      if (path && path !== ENTRY_PATH) {
        const checked = checkPath(path)
        const file = 'path' in checked ? await getFile(current.id, checked.path) : null
        if (!file)
          return text(
            `Version ${artifact.currentVersion} of "${artifact.title}" has no file "${path}". Call get_artifact without path to list its files.`,
            true,
          )
        const header = `Path: ${file.path}\nType: ${file.contentType}\nSize: ${formatBytes(file.size)}\n`
        if (isText(file.contentType)) return text(`${header}Encoding: utf8\n\n${file.content.toString('utf8')}`)
        return text(`${header}Encoding: base64\n\n${file.content.toString('base64')}`)
      }

      const html = await versionHtml(current)
      const files = await listFiles(current.id)
      const list = files.length
        ? `Files (send them all again when you publish a new version):\n` +
          [`- index.html (${formatBytes(current.htmlSize)}, this HTML)`, ...files.map((f) => `- ${f.path} (${formatBytes(f.size)})`)].join('\n') +
          '\n'
        : ''
      return text(`Title: ${artifact.title}\nVersion: ${artifact.currentVersion}\n${list}\n${html}`)
    },
  )

  server.registerTool(
    'rename_artifact',
    {
      title: 'Rename a page',
      description: 'Change the title of a page without publishing a new version. The link stays the same.',
      inputSchema: z.object({
        artifact_id: z.string().describe('Id or link of the page'),
        title: z.string().describe(`New title, 1 to ${MAX_TITLE_LENGTH} characters`),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ artifact_id, title }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const checked = checkTitle(title)
      if ('error' in checked) return text(checked.error, true)
      const updated = await rename(artifact, checked.title)
      return text(`Renamed "${artifact.title}" to "${updated.title}".\nLink: ${artifactUrl(updated.slug)}`)
    },
  )

  server.registerTool(
    'set_artifact_visibility',
    {
      title: 'Change who can open a page',
      description: 'Change who can open a page without publishing a new version.',
      inputSchema: z.object({ artifact_id: z.string().describe('Id or link of the page'), visibility }),
      annotations: { idempotentHint: true },
    },
    async ({ artifact_id, visibility }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      if (visibility === 'organization' && !artifact.organizationId)
        return text('This page is in a personal workspace. Use private (restricted) or link.', true)
      await db.update(schema.artifacts).set({ visibility }).where(eq(schema.artifacts.id, artifact.id))
      return text(`"${artifact.title}" is now ${describeVisibility(visibility)}.\nLink: ${artifactUrl(artifact.slug)}`)
    },
  )

  server.registerTool(
    'share_artifact',
    {
      title: 'Share a page with people',
      description: 'Give specific people access to a page by email, like sharing a Google Doc. They get an email with the link.',
      inputSchema: z.object({
        artifact_id: z.string().describe('Id or link of the page'),
        emails: z.array(z.string()).min(1).describe('Email addresses to share with'),
        role: z.enum(['viewer', 'editor']).default('viewer').describe('viewer can open it; editor can also publish new versions and share it'),
        message: z.string().optional().describe('Optional note included in the email'),
      }),
    },
    async ({ artifact_id, emails, role, message }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.userId))
      try {
        const { shared, notifyFailed } = await sharePeople(
          artifact,
          { id: auth.userId, email: auth.email, name: me?.name ?? null },
          parseEmails(emails),
          role,
          true,
          message,
        )
        return text(
          `Shared "${artifact.title}" with ${shared.join(', ')} as ${role}.` +
            (notifyFailed.length ? `\nThe email could not be sent to ${notifyFailed.join(', ')}; send them the link yourself.` : '') +
            `\nLink: ${artifactUrl(artifact.slug)}`,
        )
      } catch (err) {
        if (err instanceof SharingError) return text(err.message, true)
        throw err
      }
    },
  )

  return server
}

// Clients on the 2026-07-28 protocol: each request carries its own envelope, so one handler serves them all,
// building a fresh server per request for the person and workspace the verified token passed in authInfo.
// The tools send no progress or log messages, so every answer is a single JSON body.
const modern = createMcpHandler(({ authInfo }) => buildServer(authInfo?.extra?.mcp as McpAuth), { legacy: 'reject' })

export const mcp = new Hono()

mcp.all('/', async (c) => {
  const header = c.req.header('authorization')
  const auth = await authenticateBearer(header)
  if (!auth) {
    // Tells the client where to find the authorization server, which starts the browser sign-in.
    // A token that was sent but no longer works is flagged invalid_token (RFC 6750) so clients refresh it.
    const error = header ? ', error="invalid_token"' : ''
    return c.json({ error: 'unauthorized', error_description: 'Sign in to The Artifact to continue.' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"${error}`,
    })
  }
  // 2025-era clients (initialize handshake, no per-request envelope): stateless, plain JSON responses
  if (await isLegacyRequest(c.req.raw)) {
    const server = buildServer(auth)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  }
  const authInfo: AuthInfo = { token: header!.replace(/^Bearer\s+/i, ''), clientId: auth.clientName, scopes: [], extra: { mcp: auth } }
  return modern.fetch(c.req.raw, { authInfo })
})
