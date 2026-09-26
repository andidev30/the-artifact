import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  artifactUrl,
  canEdit,
  canView,
  currentHtml,
  describeVisibility,
  findBySlug,
  listForWorkspace,
  parseArtifactRef,
  publish,
  PublishError,
} from './artifacts.js'
import { db, schema } from './db/index.js'
import { parseEmails, sharePeople, SharingError } from './sharing.js'
import { authenticateBearer, RESOURCE_METADATA_URL, type McpAuth } from './oauth/server.js'

const visibility = z
  .enum(['private', 'organization', 'link'])
  .describe('private: only you and people it is shared with. organization: everyone in your organization. link: anyone with the link.')

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
        'Publish a self-contained HTML page and get a shareable link. Inline CSS and JS; external scripts from CDNs are fine. ' +
        'To update a page you published before, pass its artifact_id (or its link) and the link stays the same.',
      inputSchema: {
        title: z.string().min(1).describe('Short title shown in the gallery and browser tab'),
        html: z.string().min(1).describe('The complete HTML document'),
        artifact_id: z.string().optional().describe('Id or link of an existing page to publish a new version of'),
        visibility: visibility.optional(),
      },
    },
    async ({ title, html, artifact_id, visibility }) => {
      try {
        const artifact = await publish({
          userId: auth.userId,
          email: auth.email,
          organizationId: auth.organizationId,
          clientName: auth.clientName,
          title,
          html,
          slug: artifact_id ? parseArtifactRef(artifact_id) : undefined,
          visibility,
        })
        const verb = artifact.currentVersion === 1 ? 'Published' : `Published version ${artifact.currentVersion} of`
        return text(
          `${verb} "${artifact.title}".\n` +
            `Link: ${artifactUrl(artifact.slug)}\n` +
            `artifact_id: ${artifact.slug}\n` +
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
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = await listForWorkspace(auth.userId, auth.organizationId, 25)
      if (rows.length === 0) return text('No pages yet. Use publish_artifact to publish one.')
      return text(
        rows
          .map(({ artifact: a }) => `- ${a.title} (artifact_id: ${a.slug}, v${a.currentVersion}, ${a.visibility}) ${artifactUrl(a.slug)}`)
          .join('\n'),
      )
    },
  )

  server.registerTool(
    'get_artifact',
    {
      title: 'Read a page',
      description: 'Get the current HTML of a page, for example to edit it and publish a new version.',
      inputSchema: { artifact_id: z.string().describe('Id or link of the page') },
      annotations: { readOnlyHint: true },
    },
    async ({ artifact_id }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canView(artifact, viewer))) return text(`No page you can open has the id "${artifact_id}".`, true)
      return text(`Title: ${artifact.title}\nVersion: ${artifact.currentVersion}\n\n${await currentHtml(artifact)}`)
    },
  )

  server.registerTool(
    'set_artifact_visibility',
    {
      title: 'Change who can open a page',
      description: 'Change who can open a page without publishing a new version.',
      inputSchema: { artifact_id: z.string().describe('Id or link of the page'), visibility },
      annotations: { idempotentHint: true },
    },
    async ({ artifact_id, visibility }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      if (visibility === 'organization' && !artifact.organizationId) return text('This page is in a personal workspace. Use private or link.', true)
      await db.update(schema.artifacts).set({ visibility }).where(eq(schema.artifacts.id, artifact.id))
      return text(`"${artifact.title}" is now ${describeVisibility(visibility)}.\nLink: ${artifactUrl(artifact.slug)}`)
    },
  )

  server.registerTool(
    'share_artifact',
    {
      title: 'Share a page with people',
      description: 'Give specific people access to a page by email, like sharing a Google Doc. They get an email with the link.',
      inputSchema: {
        artifact_id: z.string().describe('Id or link of the page'),
        emails: z.array(z.string()).min(1).describe('Email addresses to share with'),
        role: z.enum(['viewer', 'editor']).default('viewer').describe('viewer can open it; editor can also publish new versions and share it'),
        message: z.string().optional().describe('Optional note included in the email'),
      },
    },
    async ({ artifact_id, emails, role, message }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.userId))
      try {
        const { shared, notifyFailed } = await sharePeople(artifact, { id: auth.userId, email: auth.email, name: me?.name ?? null }, parseEmails(emails), role, true, message)
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
  const server = buildServer(auth)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})
