import { Marked, type Tokens } from 'marked'
import { APP_URL, MCP_URL } from './config'

// The docs are the Markdown files in /docs at the repository root, so they read the same on GitHub
const files = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export type DocPage = { slug: string; title: string }
export type DocGroup = { title: string; pages: DocPage[] }

const USING: DocPage[] = [
  { slug: 'introduction', title: 'Introduction' },
  { slug: 'connect-your-agent', title: 'Connect your agent' },
  { slug: 'publishing', title: 'Publishing pages' },
  { slug: 'sharing', title: 'Sharing and permissions' },
  { slug: 'organizations', title: 'Organizations and members' },
  { slug: 'version-history', title: 'Version history' },
  { slug: 'comments', title: 'Comments' },
  { slug: 'signing-in', title: 'Signing in' },
]

const RUNNING: DocPage[] = [
  { slug: 'self-hosting', title: 'Install' },
  { slug: 'kubernetes', title: 'Kubernetes' },
  { slug: 'configuration', title: 'Configuration reference' },
  { slug: 'backups', title: 'Backup and restore' },
  { slug: 'upgrading', title: 'Upgrading' },
]

const REFERENCE: DocPage[] = [
  { slug: 'security', title: 'Security' },
  { slug: 'troubleshooting', title: 'Troubleshooting' },
]

// The hosted site, where self-hosting is one topic among others
export const DOC_GROUPS: DocGroup[] = [
  { title: 'Getting started', pages: USING.slice(0, 3) },
  { title: 'Working together', pages: USING.slice(3) },
  { title: 'Self-hosting', pages: RUNNING },
  { title: 'Reference', pages: REFERENCE },
]

// A self-hosted install, read by its own people: using it first, running it after
export const SELF_HOSTED_DOC_GROUPS: DocGroup[] = [
  { title: 'Using The Artifact', pages: USING },
  { title: 'Running this server', pages: [...RUNNING, ...REFERENCE] },
]

export const docGroups = (selfHosted: boolean) => (selfHosted ? SELF_HOSTED_DOC_GROUPS : DOC_GROUPS)

export const DOC_PAGES = DOC_GROUPS.flatMap((g) => g.pages)

export function docSource(slug: string): string | null {
  const source = files[`../../../docs/${slug}.md`]
  if (source === undefined) return null
  // Examples use this install's own address
  return source.replaceAll('{{MCP_URL}}', MCP_URL).replaceAll('{{APP_URL}}', APP_URL)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

export function headingId(text: string) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const LANG_LABEL: Record<string, string> = { sh: 'Terminal', html: 'HTML', json: 'JSON', toml: 'TOML', yaml: 'YAML' }

const markdown = new Marked({
  gfm: true,
  renderer: {
    // Code blocks get a copy button; the page wires up the clicks
    code({ text, lang }: Tokens.Code) {
      const label = lang ? (LANG_LABEL[lang] ?? lang) : ''
      return `<div class="doc-code"><div class="doc-code-bar"><span>${escapeHtml(label)}</span><button type="button" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`
    },
    // Section headings get anchors so they can be linked to
    heading({ tokens, depth }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens)
      if (depth === 1) return `<h1>${html}</h1>`
      const id = headingId(html)
      return `<h${depth} id="${id}"><a class="doc-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>`
    },
    table(token: Tokens.Table) {
      const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('')
      const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('')
      return `<div class="doc-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
    },
  },
})

// Links between docs files (docs/sharing.md) and site links (/docs/sharing) both land on the site
export function renderDoc(source: string): string {
  const html = markdown.parse(source, { async: false }) as string
  return html.replace(/href="(?:\.\/)?([a-z-]+)\.md(#[^"]*)?"/g, (_, slug, hash = '') => `href="/docs/${slug}${hash}"`)
}
