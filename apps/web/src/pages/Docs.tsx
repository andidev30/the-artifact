import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router'
import { Wordmark } from '../components/Wordmark'
import { DOC_GROUPS, DOC_PAGES, docSource, renderDoc } from '../docs'
import './Docs.css'

export function Docs() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const { hash } = useLocation()
  const article = useRef<HTMLElement>(null)

  const source = docSource(slug)
  const html = useMemo(() => (source ? renderDoc(source) : ''), [source])
  const index = DOC_PAGES.findIndex((p) => p.slug === slug)
  const page = DOC_PAGES[index]
  const prev = DOC_PAGES[index - 1]
  const next = DOC_PAGES[index + 1]

  useEffect(() => {
    if (!page) return
    document.title = `${page.title} | The Artifact docs`
    return () => { document.title = 'The Artifact' }
  }, [page])

  // Land on the linked section, or at the top of a new page
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [slug, hash])

  if (!source || !page) return <Navigate to="/docs/introduction" replace />

  // Rendered Markdown is plain HTML: route internal links in the app and handle copy buttons
  async function onClick(e: MouseEvent<HTMLElement>) {
    const el = e.target as HTMLElement
    const copy = el.closest('button[data-copy]')
    if (copy) {
      const code = copy.closest('.doc-code')?.querySelector('code')?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(code)
        copy.textContent = 'Copied'
        setTimeout(() => { copy.textContent = 'Copy' }, 1800)
      } catch {
        copy.textContent = 'Copy'
      }
      return
    }
    const link = el.closest('a')
    const href = link?.getAttribute('href')
    if (link && href?.startsWith('/') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      navigate(href)
    }
  }

  return (
    <div className="docs">
      <header className="nav">
        <div className="nav-start">
          <Wordmark />
          <Link className="docs-home" to="/docs">Docs</Link>
        </div>
        <nav aria-label="Primary">
          <Link className="nav-section" to="/#pricing">Pricing</Link>
          <Link className="button button-small" to="/docs/self-hosting">Self-host it</Link>
        </nav>
      </header>

      <div className="docs-layout">
        <aside className="docs-nav" aria-label="Documentation">
          <label className="docs-picker">
            <span className="visually-hidden">Go to a page</span>
            <select value={slug} onChange={(e) => navigate(`/docs/${e.target.value}`)}>
              {DOC_GROUPS.map((g) => (
                <optgroup key={g.title} label={g.title}>
                  {g.pages.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <nav className="docs-tree">
            {DOC_GROUPS.map((g) => (
              <div key={g.title}>
                <h2>{g.title}</h2>
                <ul>
                  {g.pages.map((p) => (
                    <li key={p.slug}><NavLink to={`/docs/${p.slug}`}>{p.title}</NavLink></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <main id="main" className="docs-main">
          <article ref={article} className="doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          <nav className="doc-pager" aria-label="Previous and next page">
            {prev ? (
              <Link to={`/docs/${prev.slug}`} rel="prev"><span>Previous</span>{prev.title}</Link>
            ) : <span />}
            {next && (
              <Link to={`/docs/${next.slug}`} rel="next" className="doc-pager-next"><span>Next</span>{next.title}</Link>
            )}
          </nav>
        </main>
      </div>
    </div>
  )
}
