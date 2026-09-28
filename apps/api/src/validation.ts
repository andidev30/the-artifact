export const EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u

// Control characters other than tab and line breaks. Postgres can't store NUL at all, and the rest
// have no place in names people read.
const CONTROL_RE = /[^\P{Cc}\t\n\r]/u
export const hasControlChars = (value: string) => CONTROL_RE.test(value)
export const CONTROL_CHARS_ERROR = "The name can't contain control characters."

// Ids from URLs and bodies are checked before a query, since a uuid column rejects anything else with an error
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
