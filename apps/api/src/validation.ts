export const EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u

// Control characters other than tab and line breaks. Postgres can't store NUL at all, and the rest
// have no place in names people read.
const CONTROL_RE = /[^\P{Cc}\t\n\r]/u
export const hasControlChars = (value: string) => CONTROL_RE.test(value)
export const CONTROL_CHARS_ERROR = "The name can't contain control characters."

// Ids from URLs and bodies are checked before a query, since a uuid column rejects anything else with an error
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Page ids (/a/<slug>, /api/artifacts/<slug>). Anything else is a missing page without asking the
// database, which can't compare text holding NUL.
export const SLUG_RE = /^[a-z0-9]{1,64}$/

// Postgres integer columns hold version numbers
export const MAX_VERSION = 2_147_483_647

// A version number from a URL: plain decimal digits in range, so "1.0", "1e0" or "+1" aren't version 1.
// Null for anything else, which callers answer as a missing version.
export function parseVersion(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d{0,9}$/.test(value)) return null
  const n = Number(value)
  return n <= MAX_VERSION ? n : null
}
