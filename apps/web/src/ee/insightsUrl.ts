// Addresses sent to Vercel Web Analytics and Speed Insights carry no secrets. Query strings and
// fragments are dropped whole: they hold sign-in link tokens (/auth/confirm?token=), OAuth consent
// requests (/authorize?request=) and `next` addresses that can nest either. Path segments that are
// secrets themselves are replaced: an invitation's token, and a page's slug, which is the link of a
// page shared by link.
const SECRET_SEGMENTS: [RegExp, string][] = [
  [/^\/invite\/[^/]+/, '/invite/[token]'],
  [/^\/a\/[^/]+/, '/a/[page]'],
]

export function scrubUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  let path = parsed.pathname
  for (const [pattern, replacement] of SECRET_SEGMENTS) path = path.replace(pattern, replacement)
  return `${parsed.origin}${path}`
}
