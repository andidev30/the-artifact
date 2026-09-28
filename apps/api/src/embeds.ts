import { Hono } from 'hono'
import type { Artifact } from './db/schema.js'
import { env } from './env.js'
import { embedLink, keyQuery, publicLink } from './links.js'
import { escapeHtml, IMAGE, linkSharedPage, SITE } from './previews.js'
import { SLUG_RE } from './validation.js'
import { currentThumbnails } from './thumbnails.js'

// Embeds: /e/<slug> is a page on its own, without the app, for other sites to frame (Notion,
// Confluence, a wiki), and GET /api/oembed describes it to tools that turn a pasted link into one.
//
// Like link previews, access is checked as a signed-out visitor, never with the request's session:
// third-party frames often get no cookies, and an embed must look the same to everyone who sees the
// site it sits on. So only a page anyone with the link can open is embedded, asked for with the link's
// current key (?k=) and without a password; restricted, organization, protected, expired and missing
// pages all get the same "sign in" card, with no title, content or
// screenshot. The page itself still loads from /api/artifacts/<slug>/v/<n>/ under its sandbox CSP, on
// CONTENT_ORIGIN when there is one. The embed document stays on the app's origin: it is the address
// people paste, runs no script, and holds nothing of the page but its frame.

// Same as the viewer's frame in the web app (pages/Viewer.tsx)
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'
const SIZE = { width: 800, height: 600 }

// The embed document runs no script and loads nothing but the page's own frame. Any site may frame
// it unless EMBED_FRAME_ANCESTORS names the ones that may (see contentCsp in content.ts).
function embedCsp() {
  const frames = env.contentOrigin ? `'self' ${env.contentOrigin}` : "'self'"
  const csp = `default-src 'none'; style-src 'unsafe-inline'; frame-src ${frames}; base-uri 'none'; form-action 'none'`
  return env.embedFrameAncestors ? `${csp}; frame-ancestors ${env.embedFrameAncestors}` : csp
}

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;font:13px/1.4 'Schibsted Grotesk',ui-sans-serif,system-ui,sans-serif;color:#1c2b4b;background:#fafbfd}
a{color:#3056d3}
.page{flex:1;width:100%;border:0;background:#fff}
.bar{display:flex;justify-content:flex-end;padding:4px 10px;border-top:1px solid #dde4ef}
.bar a{text-decoration:none}
.bar a:hover,.bar a:focus-visible{text-decoration:underline}
.card{margin:auto;padding:24px;max-width:340px;text-align:center;background:#fff;border:1px solid #3056d3;box-shadow:4px 4px 0 #dde4ef}
.card svg{width:28px;height:28px;fill:none;stroke:#3056d3;stroke-width:1.5;stroke-linejoin:round}
.card h1{margin:8px 0 4px;font-size:17px}
.card p{margin:0 0 16px;color:#4a587a}
.card a{display:inline-block;padding:6px 14px;color:#fff;background:#3056d3;text-decoration:none}
.card a:focus-visible{outline:2px solid #1c2b4b;outline-offset:2px}
`

function embedDocument(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`
}

export function embedHtml(artifact: Artifact) {
  const open = publicLink(artifact)
  // Straight to the content origin when there is one, rather than through the app's redirect
  const src = `${env.contentOrigin ?? ''}/api/artifacts/${artifact.slug}/v/${artifact.currentVersion}/${keyQuery(artifact)}`
  return embedDocument(
    `${artifact.title} | ${SITE}`,
    `<iframe class="page" src="${escapeHtml(src)}" title="${escapeHtml(artifact.title)}" sandbox="${SANDBOX}" allow="fullscreen"></iframe>
<div class="bar"><a href="${escapeHtml(open)}" target="_blank" rel="noopener">Open in ${SITE}</a></div>`,
  )
}

// The same for every page a signed-out visitor can't open; only the link back differs, and it is
// built from the address asked for, not from anything stored
export function signInCard(slug: string) {
  const open = SLUG_RE.test(slug) ? `${env.appUrl}/a/${slug}` : env.appUrl
  return embedDocument(
    SITE,
    `<div class="card">
<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 9V7a4 4 0 1 1 8 0v2M5 9h10v8H5z" /></svg>
<h1>Sign in to view this page</h1>
<p>Only people with access can see it.</p>
<a href="${escapeHtml(open)}" target="_blank" rel="noopener">Open in ${SITE}</a>
</div>`,
  )
}

// A positive whole number from a query parameter, or null when it is missing or not one
function dimension(value: string | undefined) {
  if (!value || !/^\d{1,6}$/.test(value)) return null
  const n = Number(value)
  return n > 0 ? n : null
}

// The slug of a page link on this server (/a/<slug>, or the embed address /e/<slug>), or null
export function slugFromLink(link: string): string | null {
  let url: URL
  let app: URL
  try {
    url = new URL(link)
    app = new URL(env.appUrl)
  } catch {
    return null
  }
  if (url.origin !== app.origin) return null
  const base = app.pathname.replace(/\/$/, '')
  const match = url.pathname.match(/^(.*)\/[ae]\/([^/]+)\/?$/)
  return match && match[1] === base && SLUG_RE.test(match[2]) ? match[2] : null
}

export const embeds = new Hono()

embeds.get('/e/:slug', async (c) => {
  const slug = c.req.param('slug')
  const artifact = await linkSharedPage(slug, c.req.query('k'))
  const headers = {
    'Content-Security-Policy': embedCsp(),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Checked again on every load, so a page that stops being shared by link stops showing at once
    'Cache-Control': 'no-cache',
  }
  if (!artifact) return c.html(signInCard(slug), 404, headers)
  return c.html(embedHtml(artifact), 200, headers)
})

// GET /api/oembed?url=<page link>[&maxwidth=<px>][&maxheight=<px>][&format=json], per oembed.com.
// Pages that aren't shared by link answer 404 like missing ones, without a title.
embeds.get('/api/oembed', async (c) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
  const format = c.req.query('format')
  if (format !== undefined && format !== 'json') return c.json({ error: 'Only format=json is supported.' }, 501, cors)
  const link = c.req.query('url')
  if (!link) return c.json({ error: 'Add the link to a page as url.', field: 'url' }, 400, cors)
  const slug = slugFromLink(link)
  const artifact = slug ? await linkSharedPage(slug, new URL(link).searchParams.get('k')) : null
  if (!artifact) return c.json({ error: 'Not found' }, 404, cors)

  const maxWidth = dimension(c.req.query('maxwidth'))
  const maxHeight = dimension(c.req.query('maxheight'))
  const width = Math.min(SIZE.width, maxWidth ?? SIZE.width)
  const height = Math.min(SIZE.height, maxHeight ?? SIZE.height)
  const src = embedLink(artifact)
  const html = `<iframe src="${escapeHtml(src)}" width="${width}" height="${height}" style="border:0" title="${escapeHtml(artifact.title)}" loading="lazy" allowfullscreen></iframe>`

  // Only a rendered screenshot, and only when it fits the size asked for
  const ready = (await currentThumbnails([artifact])).get(artifact.id) === 'ready'
  const fits = (maxWidth ?? Infinity) >= IMAGE.width && (maxHeight ?? Infinity) >= IMAGE.height
  const thumbnail =
    ready && fits
      ? {
          thumbnail_url: `${env.appUrl}/api/artifacts/${artifact.slug}/thumbnails/${artifact.currentVersion}${keyQuery(artifact)}`,
          thumbnail_width: IMAGE.width,
          thumbnail_height: IMAGE.height,
        }
      : {}

  return c.json(
    { version: '1.0', type: 'rich', provider_name: SITE, provider_url: env.appUrl, title: artifact.title, html, width, height, ...thumbnail },
    200,
    cors,
  )
})
