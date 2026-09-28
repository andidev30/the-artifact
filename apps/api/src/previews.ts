import type { Env, Hono } from 'hono'
import { canView, findBySlug } from './artifacts.js'
import type { Artifact } from './db/schema.js'
import { env } from './env.js'
import { log } from './log.js'
import { currentThumbnails } from './thumbnails.js'

// Link previews: chat apps and mail clients don't run the app's JavaScript, so the Open Graph tags
// for /a/<slug> go into the HTML shell the server returns.
//
// Only a page anyone with the link can open gets its own title and screenshot. Access is checked
// as a signed-out visitor, never with the request's session: a crawler has none, and the shell
// must not differ for the owner either. Restricted, organization and missing pages all get the
// same generic tags, so a preview doesn't reveal that a page exists or what it is called.

export const SITE = 'The Artifact'
// Thumbnails are stored at half the render viewport (see thumbnails.ts)
export const IMAGE = { type: 'image/webp', width: 640, height: 360 }
export const SLUG_RE = /^[a-z0-9]{1,64}$/

// The app itself is never framed by other sites (clickjacking); only /e/<slug> and page content are
// (see embeds.ts). Both headers, for browsers that predate frame-ancestors.
export const SHELL_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Frame-Options': 'SAMEORIGIN' }

export type Preview = { title: string; url: string; image: string | null }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

// A page a signed-out visitor can open, or null for restricted, organization and missing ones alike
export async function linkSharedPage(slug: string): Promise<Artifact | null> {
  if (!SLUG_RE.test(slug)) return null
  const artifact = await findBySlug(slug)
  return artifact && (await canView(artifact, null)) ? artifact : null
}

// The preview of a page, or null when it gets the generic one
export async function pagePreview(slug: string): Promise<Preview | null> {
  const artifact = await linkSharedPage(slug)
  if (!artifact) return null
  // The thumbnail route serves link-shared pages without a session, so a crawler can fetch it.
  // With thumbnails off, or before the first render, there is no image rather than a placeholder
  // that looks like every other page.
  const state = (await currentThumbnails([artifact])).get(artifact.id)
  return {
    title: artifact.title,
    url: `${env.appUrl}/a/${artifact.slug}`,
    image: state === 'ready' ? `${env.appUrl}/api/artifacts/${artifact.slug}/thumbnails/${artifact.currentVersion}` : null,
  }
}

function tag(attr: 'property' | 'name', key: string, content: string) {
  return `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`
}

export function previewTags(preview: Preview | null): string[] {
  const tags = [tag('property', 'og:site_name', SITE), tag('property', 'og:type', 'website')]
  if (!preview) return [...tags, tag('property', 'og:title', SITE), tag('name', 'twitter:card', 'summary')]
  tags.push(tag('property', 'og:title', preview.title), tag('property', 'og:url', preview.url), tag('name', 'twitter:title', preview.title))
  // oEmbed discovery, for Notion, Confluence and other tools that embed a link
  const oembed = `${env.appUrl}/api/oembed?url=${encodeURIComponent(preview.url)}&format=json`
  tags.push(`<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembed)}" title="${escapeHtml(preview.title)}" />`)
  if (!preview.image) return [...tags, tag('name', 'twitter:card', 'summary')]
  return [
    ...tags,
    tag('property', 'og:image', preview.image),
    tag('property', 'og:image:type', IMAGE.type),
    tag('property', 'og:image:width', String(IMAGE.width)),
    tag('property', 'og:image:height', String(IMAGE.height)),
    tag('name', 'twitter:card', 'summary_large_image'),
    tag('name', 'twitter:image', preview.image),
  ]
}

// Replacements are functions so a "$" in a title is not read as a replacement pattern
export function withPreview(index: string, preview: Preview | null): string {
  const title = preview ? `${preview.title} | ${SITE}` : SITE
  const tags = previewTags(preview).join('\n    ')
  return index.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`).replace('</head>', () => `  ${tags}\n  </head>`)
}

// GET /a/<slug> returns the web app's shell with the page's preview tags
export function servePagePreviews<E extends Env>(app: Hono<E>, index: string) {
  app.get('/a/:slug', async (c) => {
    let preview: Preview | null = null
    try {
      preview = await pagePreview(c.req.param('slug'))
    } catch (err) {
      // The app still has to load when the lookup fails; it only loses the preview
      log.error('Link preview failed', { path: c.req.path, error: err instanceof Error ? err.message : String(err) })
    }
    return c.html(withPreview(index, preview), 200, { 'Cache-Control': 'no-cache', ...SHELL_FRAMING })
  })
}
