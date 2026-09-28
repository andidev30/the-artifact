// Messages between the viewer and the comment helper the server adds to a page's HTML inside its
// sandboxed frame (apps/api/src/frame-helper.ts).
//
// The helper runs as part of the page, so the page's own scripts can send any of these messages, or
// anything else. Every message from the frame is untrusted data: the viewer only takes it from its own
// frame's window, parses it here into a known shape with limits, shows the text as text, and stores an
// element only when the person then confirms a comment in the app's own UI.

// Added to a version's address to ask for the helper; relative links inside the page keep it
export const HELPER_MARK = '~comments/'

export const MAX_SELECTOR_LENGTH = 500
export const MAX_SNIPPET_LENGTH = 200
const MAX_PATH_LENGTH = 300
const MAX_PINS = 200
// Far larger than any screen, small enough that a pin's position stays a sane CSS value
const MAX_COORDINATE = 100_000

export type Box = { x: number; y: number; w: number; h: number }

// An element picked in the frame, before the comment about it is posted
export type AnchorDraft = { selector: string; snippet: string; path: string; rect: Box | null }

export type FrameMessage =
  | { type: 'ready'; path: string }
  | { type: 'picked'; anchor: AnchorDraft }
  | { type: 'cancel' }
  | { type: 'hover'; snippet: string; tag: string; index: number; count: number }
  | { type: 'located'; path: string; pins: { key: number; rect: Box | null }[] }

// What the viewer sends to the helper
export type ViewerMessage =
  | { type: 'hello' }
  | { type: 'pick' }
  | { type: 'stop' }
  | { type: 'show'; key: number }
  | { type: 'locate'; anchors: { key: number; selector: string; snippet: string }[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const CONTROL_RE = /\p{Cc}/u
const SEGMENT_RE = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/

// Whitespace folded, control characters dropped, cut to length: text shown in the app and sent to the server
export function cleanSnippet(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value
    .slice(0, MAX_SNIPPET_LENGTH * 4)
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim()
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH - 1)}…` : text
}

function selector(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s && s.length <= MAX_SELECTOR_LENGTH && !CONTROL_RE.test(s) ? s : null
}

// One of the page's HTML files, by the same rules as the server's paths
export function htmlPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH) return null
  if (!/\.html?$/i.test(value) || !value.split('/').every((s) => SEGMENT_RE.test(s))) return null
  return value
}

const fraction = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null)
const coordinate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE ? v : null)

function box(value: unknown, read: (v: unknown) => number | null): Box | null {
  if (!isRecord(value)) return null
  const [x, y, w, h] = [read(value.x), read(value.y), read(value.w), read(value.h)]
  if (x === null || y === null || w === null || h === null || w < 0 || h < 0) return null
  return { x, y, w, h }
}

const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null)

// The message in a known shape, or null for anything else, which the viewer ignores
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.artifact !== 1 || typeof data.type !== 'string') return null
  switch (data.type) {
    case 'ready': {
      const path = htmlPath(data.path)
      return path ? { type: 'ready', path } : null
    }
    case 'cancel':
      return { type: 'cancel' }
    case 'picked': {
      const s = selector(data.selector)
      const path = htmlPath(data.path)
      if (!s || !path) return null
      return { type: 'picked', anchor: { selector: s, snippet: cleanSnippet(data.snippet), path, rect: box(data.rect, fraction) } }
    }
    case 'hover': {
      const index = count(data.index, 10_000)
      const total = count(data.count, 10_000)
      if (index === null || total === null) return null
      const tag = typeof data.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/i.test(data.tag) ? data.tag.toLowerCase() : ''
      return { type: 'hover', snippet: cleanSnippet(data.snippet), tag, index, count: total }
    }
    case 'located': {
      const path = htmlPath(data.path)
      if (!path || !Array.isArray(data.pins) || data.pins.length > MAX_PINS) return null
      const pins: { key: number; rect: Box | null }[] = []
      for (const p of data.pins) {
        const key = isRecord(p) ? count(p.key, MAX_PINS - 1) : null
        if (key === null) return null
        pins.push({ key, rect: p.rect === null ? null : box(p.rect, coordinate) })
      }
      return { type: 'located', path, pins }
    }
    default:
      return null
  }
}

// Words for a screen reader while moving through the page's elements with the keyboard
const TAG_NAMES: Record<string, string> = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: 'Paragraph',
  li: 'List item',
  img: 'Image',
  svg: 'Graphic',
  canvas: 'Graphic',
  table: 'Table',
  td: 'Table cell',
  th: 'Table header',
  a: 'Link',
  button: 'Button',
  figure: 'Figure',
  section: 'Section',
}

export function describeHover(m: { snippet: string; tag: string; index: number; count: number }): string {
  const kind = TAG_NAMES[m.tag] ?? 'Element'
  return `${kind}${m.snippet ? `: ${m.snippet}` : ''}. ${m.index} of ${m.count}.`
}
