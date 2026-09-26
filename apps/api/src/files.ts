import { createHash } from 'node:crypto'

// A page is one entry HTML document, optionally with files next to it (CSS, JS, images, fonts, data)
// that it references by relative paths. These limits keep a page a page, not a file host.
export const MAX_HTML_BYTES = 2 * 1024 * 1024
export const MAX_FILE_BYTES = 5 * 1024 * 1024
// Entry HTML plus every file
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 100
export const MAX_PATH_LENGTH = 200
export const ENTRY_PATH = 'index.html'

export class PublishError extends Error {}

export type FileInput = { path: string; content: string; encoding?: 'utf8' | 'base64' }

export type PreparedFile = { path: string; content: Buffer; contentType: string; size: number; sha256: string }

const TEXT = 'text'
const BINARY = 'binary'

// Only these kinds of files can be published, and each is served with its own type (never sniffed)
const TYPES: Record<string, { type: string; kind: typeof TEXT | typeof BINARY }> = {
  html: { type: 'text/html; charset=utf-8', kind: TEXT },
  htm: { type: 'text/html; charset=utf-8', kind: TEXT },
  css: { type: 'text/css; charset=utf-8', kind: TEXT },
  js: { type: 'text/javascript; charset=utf-8', kind: TEXT },
  mjs: { type: 'text/javascript; charset=utf-8', kind: TEXT },
  json: { type: 'application/json; charset=utf-8', kind: TEXT },
  map: { type: 'application/json; charset=utf-8', kind: TEXT },
  txt: { type: 'text/plain; charset=utf-8', kind: TEXT },
  md: { type: 'text/markdown; charset=utf-8', kind: TEXT },
  csv: { type: 'text/csv; charset=utf-8', kind: TEXT },
  xml: { type: 'application/xml; charset=utf-8', kind: TEXT },
  svg: { type: 'image/svg+xml; charset=utf-8', kind: TEXT },
  png: { type: 'image/png', kind: BINARY },
  jpg: { type: 'image/jpeg', kind: BINARY },
  jpeg: { type: 'image/jpeg', kind: BINARY },
  gif: { type: 'image/gif', kind: BINARY },
  webp: { type: 'image/webp', kind: BINARY },
  avif: { type: 'image/avif', kind: BINARY },
  ico: { type: 'image/x-icon', kind: BINARY },
  woff: { type: 'font/woff', kind: BINARY },
  woff2: { type: 'font/woff2', kind: BINARY },
  ttf: { type: 'font/ttf', kind: BINARY },
  otf: { type: 'font/otf', kind: BINARY },
  mp3: { type: 'audio/mpeg', kind: BINARY },
  wav: { type: 'audio/wav', kind: BINARY },
  ogg: { type: 'audio/ogg', kind: BINARY },
  mp4: { type: 'video/mp4', kind: BINARY },
  webm: { type: 'video/webm', kind: BINARY },
  wasm: { type: 'application/wasm', kind: BINARY },
}

export const ALLOWED_EXTENSIONS = Object.keys(TYPES)

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function contentTypeFor(path: string): string | null {
  return TYPES[extension(path)]?.type ?? null
}

const SEGMENT = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/

// A clean relative path like "assets/app.js", or an error message an agent can act on
export function checkPath(raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string' || !raw) return { error: 'Every file needs a path, like "style.css" or "img/logo.png".' }
  const path = raw.startsWith('./') ? raw.slice(2) : raw
  const shown = JSON.stringify(raw)
  if (path.length > MAX_PATH_LENGTH) return { error: `The path ${shown.slice(0, 60)}… is longer than ${MAX_PATH_LENGTH} characters.` }
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('\\')) {
    return { error: `The path ${shown} must be relative to the page, like "img/logo.png".` }
  }
  const segments = path.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return { error: `The path ${shown} can't contain "." or ".." segments.` }
  if (segments.some((s) => !SEGMENT.test(s))) {
    return { error: `The path ${shown} can only use letters, digits and . _ - @ + in each part, and parts can't start with a dot.` }
  }
  return { path }
}

// Validates and decodes the files an agent sent. htmlBytes counts towards the total.
export function prepareFiles(files: FileInput[] | undefined, htmlBytes: number): PreparedFile[] {
  if (!files || files.length === 0) return []
  if (files.length > MAX_FILES) throw new PublishError(`A page can have at most ${MAX_FILES} files besides the HTML; this one has ${files.length}.`)

  const seen = new Set<string>()
  let total = htmlBytes
  const prepared: PreparedFile[] = []
  for (const file of files) {
    const checked = checkPath(file?.path)
    if ('error' in checked) throw new PublishError(checked.error)
    const { path } = checked
    if (path.toLowerCase() === ENTRY_PATH) throw new PublishError('index.html is the page itself: send it as html, not as a file.')
    const key = path.toLowerCase()
    if (seen.has(key)) throw new PublishError(`Two files have the path "${path}".`)
    seen.add(key)

    const ext = extension(path)
    const type = TYPES[ext]
    if (!type) throw new PublishError(`"${path}" isn't a supported file type. Use one of: ${ALLOWED_EXTENSIONS.join(', ')}.`)
    if (typeof file.content !== 'string') throw new PublishError(`"${path}" has no content.`)

    const encoding = file.encoding ?? 'utf8'
    let content: Buffer
    if (encoding === 'base64') {
      const b64 = file.content.replace(/\s+/g, '')
      if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new PublishError(`"${path}" isn't valid base64.`)
      content = Buffer.from(b64, 'base64')
    } else if (encoding === 'utf8') {
      if (type.kind === BINARY) throw new PublishError(`"${path}" is a binary file: send it with encoding "base64".`)
      content = Buffer.from(file.content, 'utf8')
    } else {
      throw new PublishError(`"${path}" has an unknown encoding; use "utf8" or "base64".`)
    }

    if (content.length > MAX_FILE_BYTES) throw new PublishError(`"${path}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
    total += content.length
    if (total > MAX_TOTAL_BYTES) throw new PublishError(`The page and its files add up to more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB. Compress images or load large media from a URL.`)
    prepared.push({ path, content, contentType: type.type, size: content.length, sha256: sha256(content) })
  }
  return prepared
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

// Text types go back to agents as text, everything else as base64
export function isText(contentType: string): boolean {
  return /^text\/|^application\/(json|xml)|^image\/svg\+xml/.test(contentType)
}
