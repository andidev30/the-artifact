import { Link } from 'react-router'

// Kept apart from Legal.tsx so the landing page's footer doesn't pull in the texts and the Markdown renderer
export const LEGAL_PAGES = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'subprocessors', title: 'Sub-processors' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
] as const

export type LegalSlug = (typeof LEGAL_PAGES)[number]['slug']

// The marketing footer: every legal page is one click from the landing page
export function LegalFooter() {
  return (
    <footer className="footer">
      <span>The Artifact</span>
      <nav className="footer-links" aria-label="Legal">
        {LEGAL_PAGES.map((p) => (
          <Link key={p.slug} to={`/legal/${p.slug}`}>
            {p.title}
          </Link>
        ))}
      </nav>
      <span>andidev30</span>
    </footer>
  )
}
