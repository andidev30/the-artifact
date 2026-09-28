import { useEffect, useMemo, type MouseEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router'
import { Wordmark } from '../components/Wordmark'
import { APP_URL, DOCS_URL } from '../config'
import { renderDoc } from '../docs'
import { NotFound } from '../pages/NotFound'
import dpa from './legal/dpa.md?raw'
import privacy from './legal/privacy.md?raw'
import subprocessors from './legal/subprocessors.md?raw'
import terms from './legal/terms.md?raw'
import { LEGAL_PAGES, LegalFooter, type LegalSlug } from './LegalFooter'
import '../pages/Docs.css'
import './Landing.css'

// The hosted service's legal pages. Self-hosted installs never load them (see pages/Home.tsx): whoever
// runs one sets their own terms. The texts are Markdown next to this file so they read like documents.
const SOURCES: Record<LegalSlug, string> = { terms, privacy, subprocessors, dpa }

export function Legal() {
  const { doc = '' } = useParams()
  const navigate = useNavigate()
  const { hash } = useLocation()
  const page = LEGAL_PAGES.find((p) => p.slug === doc)
  const html = useMemo(() => (page ? renderDoc(SOURCES[page.slug].replaceAll('{{APP_URL}}', APP_URL)) : ''), [page])

  useEffect(() => {
    if (!page) return
    document.title = `${page.title} | The Artifact`
    return () => {
      document.title = 'The Artifact'
    }
  }, [page])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page without a hash still starts at the top
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
    if (target) target.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [doc, hash])

  if (!page) return <NotFound />

  // Rendered Markdown is plain HTML: route links inside the app without reloading it
  function onClick(e: MouseEvent<HTMLElement>) {
    const link = (e.target as HTMLElement).closest('a')
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
          <Link className="docs-home" to="/legal/terms">
            Legal
          </Link>
        </div>
        <nav aria-label="Primary">
          <Link className="nav-section" to="/#pricing">
            Pricing
          </Link>
          <Link className="nav-section" to={DOCS_URL}>
            Docs
          </Link>
        </nav>
      </header>

      <div className="docs-layout">
        <aside className="docs-nav" aria-label="Legal pages">
          <label className="docs-picker">
            <span className="visually-hidden">Go to a page</span>
            <select value={doc} onChange={(e) => navigate(`/legal/${e.target.value}`)}>
              {LEGAL_PAGES.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <nav className="docs-tree">
            <ul>
              {LEGAL_PAGES.map((p) => (
                <li key={p.slug}>
                  <NavLink to={`/legal/${p.slug}`}>{p.title}</NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <main id="main" className="docs-main">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: this folder's own Markdown, rendered like the docs */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: routes clicks on the links inside, which handle keys themselves */}
          <article className="doc" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        </main>
      </div>
      <LegalFooter />
    </div>
  )
}
