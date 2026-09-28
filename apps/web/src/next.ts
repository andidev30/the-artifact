// Where to go after signing in (`next`): a path on this app, or nothing. The
// API has the same check in apps/api/src/auth/next.ts; keep the two alike.
//
// URL parsers drop tabs and newlines and read a backslash as a slash, so "/\t/host" or "/\host"
// can turn into "//host", another site. Anything with a backslash or a control character, raw or
// percent-encoded, is refused rather than cleaned up, and what is left must resolve to this
// app's own origin.

function unsafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function sameOriginPath(next: unknown, appUrl: string): string | null {
  if (typeof next !== 'string' || next.length > 2000) return null
  if (!next.startsWith('/') || next.startsWith('//')) return null
  if (unsafe(next)) return null
  const plain = decoded(next)
  if (plain === null || unsafe(plain) || plain.startsWith('//')) return null
  let base: URL
  let url: URL
  try {
    base = new URL(appUrl)
    url = new URL(next, base)
  } catch {
    return null
  }
  if (url.origin !== base.origin) return null
  // "/..//host" resolves to the path "//host", which a browser reads as another site
  const path = `${url.pathname}${url.search}${url.hash}`
  if (path.startsWith('//')) return null
  return path
}
