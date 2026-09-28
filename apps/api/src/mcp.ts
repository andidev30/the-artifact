import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type AuthInfo } from '@modelcontextprotocol/server'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  accessLevel,
  artifactUrl,
  canDelete,
  canEdit,
  canView,
  checkTitle,
  deleteArtifact,
  describeVisibility,
  findBySlug,
  getFile,
  getVersion,
  listFiles,
  versionHtml,
  listForWorkspace,
  listVersions,
  MAX_TITLE_LENGTH,
  parseArtifactRef,
  publish,
  PublishError,
  publishUpload,
  rename,
  restoreVersion,
  VISIBILITY_LABEL,
} from './artifacts.js'
import { allowed, downloadLink, TOKEN_HOURS } from './content.js'
import { db, schema } from './db/index.js'
import type { Artifact } from './db/schema.js'
import { hit, rule, waitText, windowText } from './limits.js'
import { ALLOWED_EXTENSIONS, checkPath, ENTRY_PATH, isText, MAX_FILE_BYTES, MAX_FILES, MAX_HTML_BYTES, MAX_TOTAL_BYTES } from './files.js'
import { MAX_PEOPLE_PER_INVITE, parseEmails, sharePeople, SharingError } from './sharing.js'
import { authenticateBearer, RESOURCE_METADATA_URL, type McpAuth } from './oauth/server.js'
import { directUploads, UPLOAD_TTL_SECONDS } from './storage.js'
import { prepareUpload } from './uploads.js'

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

function published(artifact: Artifact, otherFiles: number) {
  const verb = artifact.currentVersion === 1 ? 'Published' : `Published version ${artifact.currentVersion} of`
  return text(
    `${verb} "${artifact.title}".\n` +
      `Link: ${artifactUrl(artifact.slug)}\n` +
      `artifact_id: ${artifact.slug}\n` +
      (otherFiles ? `Files: index.html and ${otherFiles} more.\n` : '') +
      `Visibility: ${describeVisibility(artifact.visibility)}.`,
  )
}

const manifest = z
  .array(
    z.object({
      path: z.string().describe('index.html for the page itself, or the relative path the HTML uses for a file, e.g. "img/hero.png"'),
      size: z.number().int().nonnegative().describe('Size in bytes, e.g. from wc -c'),
      sha256: z.string().describe('SHA-256 of the exact bytes, as hex, e.g. from sha256sum or shasum -a 256'),
    }),
  )
  .min(1)

// What to tell the agent when the account is past a limit, or null. Every tool call counts toward
// "mcp", and the ones that publish a version toward "publish" as well.
async function overLimit(userId: string, publishes: boolean): Promise<string | null> {
  const calls = await hit('mcp', userId)
  if (calls) return refusal('mcp', 'tool calls', calls)
  const published = publishes ? await hit('publish', userId) : null
  if (published) return refusal('publish', 'new pages and versions', published)
  return null
}

function refusal(name: string, what: string, wait: number) {
  const r = rule(name)!
  return `This account is past this server's limit of ${r.max} ${what} per ${windowText(r.seconds)}. Try again in ${waitText(wait)}.`
}

// One server per request (stateless), bound to the person and workspace behind the token
function buildServer(auth: McpAuth) {
  const viewer = { id: auth.userId, email: auth.email }
  const server = new McpServer({ name: 'the-artifact', version: '0.1.0' })

  // A limit is reported as the tool's error, which the agent reads and can pass on. An HTTP 429
  // would reach most MCP clients as a failed request, without the message.
  const limited =
    <A, R>(handler: (args: A) => Promise<R>, publishes = false) =>
    async (args: A) => {
      const refused = await overLimit(auth.userId, publishes)
      return refused ? text(refused, true) : handler(args)
    }

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish a page',
      description:
        'Publish an HTML page and get a shareable link. Either one self-contained document (inline CSS and JS; scripts from public CDNs are fine), ' +
        'or a small site: html is the entry (index.html) and files holds the CSS, JS, images, fonts and data it loads by relative paths. ' +
        `Limits: html up to ${MAX_HTML_BYTES / 1024 / 1024} MB, each file up to ${MAX_FILE_BYTES / 1024 / 1024} MB, ${MAX_TOTAL_BYTES / 1024 / 1024} MB and ${MAX_FILES} files in total. ` +
        'To update a page you published before, pass its artifact_id (or its link) and the link stays the same; send every file again, since each version has its own full set.' +
        (directUploads()
          ? ' If you can run shell commands or make HTTP requests, prefer prepare_upload and publish_upload for pages with images, fonts or media, or over 1 MB: the files go straight to storage instead of through this call.'
          : ''),
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
    limited(async ({ title, html, files, artifact_id, visibility }) => {
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
        return published(artifact, files?.length ?? 0)
      } catch (err) {
        if (err instanceof PublishError) return text(err.message, true)
        throw err
      }
    }, true),
  )

  if (directUploads()) {
    server.registerTool(
      'prepare_upload',
      {
        title: 'Prepare to upload a page',
        description:
          'First step of publishing a page by uploading its files yourself, for agents that can run shell commands or make HTTP requests. ' +
          'List every file of the page with its size and sha256, including index.html (the page itself). Returns an upload_id and a link per file: ' +
          "PUT each file's exact bytes to its link, then call publish_upload with the upload_id and the same files. " +
          `Files already stored need no upload. The same limits as publish_artifact apply: html up to ${MAX_HTML_BYTES / 1024 / 1024} MB, ` +
          `each file up to ${MAX_FILE_BYTES / 1024 / 1024} MB, ${MAX_TOTAL_BYTES / 1024 / 1024} MB and ${MAX_FILES} files in total. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}.`,
        inputSchema: z.object({ files: manifest.describe('Every file of the page, index.html included') }),
      },
      limited(async ({ files }) => {
        try {
          const { uploadId, uploads, stored } = await prepareUpload(files)
          const commands = uploads.map((u) => `curl -fsS -T '${u.paths[0]}' '${u.url}'${u.paths.length > 1 ? `  # also ${u.paths.slice(1).join(', ')}` : ''}`)
          return text(
            `upload_id: ${uploadId}\n` +
              (uploads.length
                ? `PUT each file's exact bytes to its link within ${UPLOAD_TTL_SECONDS / 60} minutes, for example with curl from the page's folder:\n${commands.join('\n')}\n`
                : '') +
              (stored.length ? `Already stored, no upload needed: ${stored.join(', ')}\n` : '') +
              'Then call publish_upload with this upload_id, the title and the same files.',
          )
        } catch (err) {
          if (err instanceof PublishError) return text(err.message, true)
          throw err
        }
      }),
    )

    server.registerTool(
      'publish_upload',
      {
        title: 'Publish uploaded files',
        description:
          'Second step after prepare_upload: checks that every file arrived with the size and sha256 you listed, then publishes the page and returns its link. ' +
          'Pass artifact_id to publish a new version of an existing page; the link stays the same.',
        inputSchema: z.object({
          title: z.string().min(1).describe('Short title shown in the gallery and browser tab'),
          upload_id: z.string().describe('The upload_id prepare_upload returned'),
          files: manifest.describe('The same files you passed to prepare_upload'),
          artifact_id: z.string().optional().describe('Id or link of an existing page to publish a new version of'),
          visibility: visibility.optional(),
        }),
      },
      limited(async ({ title, upload_id, files, artifact_id, visibility }) => {
        try {
          const artifact = await publishUpload({
            userId: auth.userId,
            email: auth.email,
            organizationId: auth.organizationId,
            clientName: auth.clientName,
            title,
            uploadId: upload_id,
            files,
            slug: artifact_id ? parseArtifactRef(artifact_id) : undefined,
            visibility,
          })
          return published(artifact, files.length - 1)
        } catch (err) {
          if (err instanceof PublishError) return text(err.message, true)
          throw err
        }
      }, true),
    )
  }

  server.registerTool(
    'list_artifacts',
    {
      title: 'List pages',
      description: 'List the most recently updated pages in the connected workspace.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    limited(async () => {
      const rows = await listForWorkspace(auth.userId, auth.organizationId, 25)
      if (rows.length === 0) return text('No pages yet. Use publish_artifact to publish one.')
      return text(
        rows
          .map(({ artifact: a }) => `- ${a.title} (artifact_id: ${a.slug}, v${a.currentVersion}, ${VISIBILITY_LABEL[a.visibility]}) ${artifactUrl(a.slug)}`)
          .join('\n'),
      )
    }),
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
    limited(async ({ artifact_id, path }) => {
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
    }),
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
    limited(async ({ artifact_id, title }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const checked = checkTitle(title)
      if ('error' in checked) return text(checked.error, true)
      const updated = await rename(artifact, checked.title)
      return text(`Renamed "${artifact.title}" to "${updated.title}".\nLink: ${artifactUrl(updated.slug)}`)
    }),
  )

  server.registerTool(
    'set_artifact_visibility',
    {
      title: 'Change who can open a page',
      description: 'Change who can open a page without publishing a new version.',
      inputSchema: z.object({ artifact_id: z.string().describe('Id or link of the page'), visibility }),
      annotations: { idempotentHint: true },
    },
    limited(async ({ artifact_id, visibility }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      if (visibility === 'organization' && !artifact.organizationId)
        return text('This page is in a personal workspace. Use private (restricted) or link.', true)
      await db.update(schema.artifacts).set({ visibility }).where(eq(schema.artifacts.id, artifact.id))
      return text(`"${artifact.title}" is now ${describeVisibility(visibility)}.\nLink: ${artifactUrl(artifact.slug)}`)
    }),
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
    limited(async ({ artifact_id, emails, role, message }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const people = parseEmails(emails)
      // Shares email people, so they count toward the same limit as invitations in the web app
      const wait = await hit('invite', auth.userId, Math.min(people.length, MAX_PEOPLE_PER_INVITE))
      if (wait) return text(refusal('invite', 'people invited or shared with', wait), true)
      const [me] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, auth.userId))
      try {
        const { shared, notifyFailed } = await sharePeople(
          artifact,
          { id: auth.userId, email: auth.email, name: me?.name ?? null },
          people,
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
    }),
  )

  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete a page',
      description:
        'Delete a page for good, like deleting it from the gallery: the link stops working for everyone and every version is deleted. ' +
        'Only the owner of a page can delete it. This cannot be undone, so only call it when the person asked to delete this page.',
      inputSchema: z.object({ artifact_id: z.string().describe('Id or link of the page') }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    limited(async ({ artifact_id }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !canDelete(artifact, viewer)) return text(`No page you own has the id "${artifact_id}". Only the owner of a page can delete it.`, true)
      await deleteArtifact(artifact)
      return text(`Deleted "${artifact.title}". Its link no longer works.`)
    }),
  )

  server.registerTool(
    'list_versions',
    {
      title: 'List the versions of a page',
      description: "List every version of a page, newest first, as the page's version history shows them. For people who can edit the page.",
      inputSchema: z.object({ artifact_id: z.string().describe('Id or link of the page') }),
      annotations: { readOnlyHint: true },
    },
    limited(async ({ artifact_id }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      const rows = await listVersions(artifact)
      const lines = rows.map((v) => {
        const by = v.publishedByName ?? v.publishedByEmail
        const how = v.restoredFrom ? `restored from version ${v.restoredFrom}` : v.publishedWith ? `published with ${v.publishedWith}` : 'published'
        const when = `${v.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
        return `- Version ${v.version}${v.version === artifact.currentVersion ? ' (current)' : ''}: ${when}, ${how}${by ? ` by ${by}` : ''}`
      })
      return text(`Versions of "${artifact.title}", newest first:\n${lines.join('\n')}\nUse restore_version to make an older one current again.`)
    }),
  )

  server.registerTool(
    'restore_version',
    {
      title: 'Restore an older version',
      description:
        'Make an older version of a page current again, like Restore this version in the history. ' +
        'Nothing is overwritten: its HTML and files are published again as a new version, and the link stays the same. For people who can edit the page.',
      inputSchema: z.object({
        artifact_id: z.string().describe('Id or link of the page'),
        version: z.number().int().positive().describe('The version number to restore, from list_versions'),
      }),
    },
    limited(async ({ artifact_id, version }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      if (!artifact || !(await canEdit(artifact, viewer))) return text(`No page you can edit has the id "${artifact_id}".`, true)
      if (version === artifact.currentVersion) return text('This is already the current version.', true)
      const updated = await restoreVersion(artifact, version, auth.userId)
      if (!updated) return text(`"${artifact.title}" has no version ${version}. Call list_versions to see its versions.`, true)
      return text(`Restored version ${version} of "${updated.title}" as version ${updated.currentVersion}.\nLink: ${artifactUrl(updated.slug)}`)
    }, true),
  )

  server.registerTool(
    'download_artifact',
    {
      title: 'Download a page as a zip',
      description:
        'Get a link that downloads a page and all its files as one zip, for agents that can run shell commands or make HTTP requests, ' +
        `e.g. to work on the page locally. The link works for you for ${TOKEN_HOURS} hours and needs no sign-in. ` +
        'Pass version for an older version (editors only). To read the files one at a time instead, use get_artifact.',
      inputSchema: z.object({
        artifact_id: z.string().describe('Id or link of the page'),
        version: z.number().int().positive().optional().describe('A version number from list_versions; omit for the current version'),
      }),
      annotations: { readOnlyHint: true },
    },
    limited(async ({ artifact_id, version }) => {
      const artifact = await findBySlug(parseArtifactRef(artifact_id))
      const n = version ?? artifact?.currentVersion
      if (!artifact || !n || !allowed(await accessLevel(artifact, viewer), n === artifact.currentVersion))
        return text(`No page you can open has the id "${artifact_id}".`, true)
      const v = await getVersion(artifact, n)
      if (!v) return text(`"${artifact.title}" has no version ${n}.`, true)
      const files = await listFiles(v.id)
      const link = await downloadLink(auth.userId, artifact, n)
      return text(
        `Version ${n} of "${artifact.title}": index.html${files.length ? ` and ${files.length} more ${files.length === 1 ? 'file' : 'files'}` : ''}.\n` +
          `Download: ${link}\n` +
          `For example: curl -fsSL -o page.zip '${link}'`,
      )
    }),
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
