import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import { CliError } from './errors.ts'

// The server checks all of this again (apps/api/src/files.ts); checking here first means a build
// folder with a stray 50 MB video fails at once with a clear message instead of after the upload.
export const MAX_HTML_BYTES = 2 * 1024 * 1024
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 100
export const ENTRY_PATH = 'index.html'

// The types a page can hold, as in apps/api/src/files.ts. Anything else is left out with a note
// rather than failing the publish, since build folders often hold .gz copies, licenses and the like.
export const ALLOWED_EXTENSIONS = new Set([
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'json',
  'map',
  'txt',
  'md',
  'csv',
  'xml',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'wav',
  'ogg',
  'mp4',
  'webm',
  'wasm',
])

const SKIPPED_FOLDERS = new Set(['node_modules'])

export type PageFile = { path: string; abs: string; size: number }
export type Skipped = { path: string; reason: string }
export type Collected = { entry: PageFile; files: PageFile[]; skipped: Skipped[]; total: number }

function isHtml(path: string) {
  return /\.html?$/i.test(path)
}

function hasAllowedType(path: string) {
  return ALLOWED_EXTENSIONS.has(extname(path).slice(1).toLowerCase())
}

// A glob as a regular expression: * within a path part, ** across parts, ? one character
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      // "**/" also matches no folder at all, so "**/x" matches "x"
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Like .gitignore: a pattern without a slash matches a file or folder name at any depth, one with a
// slash matches the path from the top of the folder. A trailing slash only matches folders.
export function ignoreMatcher(patterns: string[]): (path: string, isDir: boolean) => boolean {
  const rules = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const dirOnly = p.endsWith('/')
      const body = p.replace(/^\.\//, '').replace(/\/+$/, '')
      const anchored = body.includes('/')
      return { re: globToRegExp(body.replace(/^\//, '')), dirOnly, anchored }
    })
  return (path, isDir) =>
    rules.some((r) => {
      if (r.dirOnly && !isDir) return false
      return r.re.test(r.anchored ? path : path.slice(path.lastIndexOf('/') + 1))
    })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// The text of the document's <title>, or null
export function titleFromHtml(html: string): string | null {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  if (!match) return null
  const text = match[1]
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 200) : null
}

// The title when there is no <title>: the folder's or file's name
export function fallbackTitle(target: string, isDir: boolean): string {
  const name = basename(target)
  return (isDir ? name : name.replace(/\.html?$/i, '')) || 'Untitled page'
}

function toPosix(path: string) {
  return sep === '/' ? path : path.split(sep).join('/')
}

function formatMb(bytes: number) {
  return `${bytes / 1024 / 1024} MB`
}

// The entry is null for an update that doesn't replace it
export function checkLimits(collected: { entry: PageFile | null; files: PageFile[]; total: number }) {
  const { entry, files, total } = collected
  if (entry?.size === 0) throw new CliError(`${entry.path} is empty.`)
  if (entry && entry.size > MAX_HTML_BYTES)
    throw new CliError(`${entry.path} is larger than ${formatMb(MAX_HTML_BYTES)}. Move large assets into files or compress images.`)
  if (files.length > MAX_FILES)
    throw new CliError(`A page can have at most ${MAX_FILES} files besides the HTML; this one has ${files.length}. Use --ignore to leave some out.`)
  const big = files.find((f) => f.size > MAX_FILE_BYTES)
  if (big) throw new CliError(`${big.path} is larger than ${formatMb(MAX_FILE_BYTES)}. Compress it, load it from a URL, or leave it out with --ignore.`)
  if (total > MAX_TOTAL_BYTES)
    throw new CliError(
      `The page and its files add up to more than ${formatMb(MAX_TOTAL_BYTES)}. Compress images, load large media from a URL, or leave files out with --ignore.`,
    )
}

// Every file in a folder, except hidden files and folders, node_modules and ignored paths, which are
// never read. Links to folders are noted rather than followed.
async function walkFolder(target: string, ignored: (path: string, isDir: boolean) => boolean): Promise<{ found: PageFile[]; skipped: Skipped[] }> {
  const found: PageFile[] = []
  const skipped: Skipped[] = []
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const item of entries) {
      const abs = join(dir, item.name)
      const path = toPosix(relative(target, abs))
      if (item.name.startsWith('.') || SKIPPED_FOLDERS.has(item.name)) continue
      // Follows links to files, not to folders, which could loop or leave the folder
      const real = item.isSymbolicLink() ? await stat(abs).catch(() => null) : null
      const isDir = real ? real.isDirectory() : item.isDirectory()
      const isFile = real ? real.isFile() : item.isFile()
      if (ignored(path, isDir)) continue
      if (isDir) {
        if (real) skipped.push({ path, reason: 'a link to a folder' })
        else await walk(abs)
        continue
      }
      if (!isFile) continue
      found.push({ path, abs, size: real ? real.size : (await stat(abs)).size })
    }
  }
  await walk(target)
  return { found, skipped }
}

async function statTarget(target: string, label: string) {
  const info = await stat(target).catch(() => null)
  if (!info) throw new CliError(`There is no file or folder at ${label}.`)
  if (!info.isFile() && !info.isDirectory()) throw new CliError(`${label} is neither a file nor a folder.`)
  return info
}

function entryPathOf(entry: string | undefined): string {
  const entryPath = toPosix(entry ?? ENTRY_PATH).replace(/^\.\//, '')
  if (!isHtml(entryPath)) throw new CliError(`--entry ${entryPath} isn't an HTML file.`)
  return entryPath
}

// What publishing `target` sends: a single HTML file, or a folder's entry HTML and the files next to it
export async function collectPage(target: string, opts: { entry?: string; ignore?: string[]; label?: string } = {}): Promise<Collected & { isDir: boolean }> {
  const label = opts.label ?? target
  const info = await statTarget(target, label)

  if (info.isFile()) {
    if (opts.entry) throw new CliError('--entry is for publishing a folder. To publish one file, pass the file itself.')
    if (!isHtml(target)) throw new CliError(`${label} isn't an HTML file. Pass an .html file, or a folder with an index.html.`)
    const entry = { path: basename(target), abs: target, size: info.size }
    return { entry, files: [], skipped: [], total: info.size, isDir: false }
  }

  const entryPath = entryPathOf(opts.entry)
  const { found, skipped } = await walkFolder(target, ignoreMatcher(opts.ignore ?? []))
  const files: PageFile[] = []
  let entry: PageFile | null = null
  for (const file of found) {
    const path = file.path
    if (path.toLowerCase() === entryPath.toLowerCase()) {
      entry = file
    } else if (path.toLowerCase() === ENTRY_PATH) {
      skipped.push({ path, reason: `the page itself is ${entryPath}` })
    } else if (!hasAllowedType(path)) {
      skipped.push({ path, reason: 'not a type pages can hold' })
    } else {
      files.push(file)
    }
  }

  if (!entry) {
    throw new CliError(
      opts.entry ? `There is no ${entryPath} in ${label}.` : `There is no index.html in ${label}. Pass --entry to choose the page's HTML file.`,
    )
  }
  const total = files.reduce((n, f) => n + f.size, entry.size)
  return { entry, files, skipped, total, isDir: true }
}

// Some files of a page, for an update of it (--only): the files of `target` matching any of the
// patterns, which are paths or globs relative to it. The entry HTML, when it matches, is sent as
// index.html. Unlike a whole page, the folder needn't hold the rest of the page, so a job can write
// only the files it changes.
export async function collectSome(
  target: string,
  patterns: string[],
  opts: { entry?: string; ignore?: string[]; label?: string } = {},
): Promise<{ entry: PageFile | null; files: PageFile[]; skipped: Skipped[]; total: number }> {
  const label = opts.label ?? target
  const info = await statTarget(target, label)
  const matchers = patterns.map((p) => ({ pattern: p, re: globToRegExp(toPosix(p).replace(/^\.\//, '')) }))
  const used = new Set<string>()
  const matches = (path: string, alias?: string) => {
    const hits = matchers.filter((m) => m.re.test(path) || (alias !== undefined && m.re.test(alias)))
    for (const m of hits) used.add(m.pattern)
    return hits.length > 0
  }

  let entry: PageFile | null = null
  const files: PageFile[] = []
  const skipped: Skipped[] = []
  if (info.isFile()) {
    if (opts.entry) throw new CliError('--entry is for publishing a folder. To publish one file, pass the file itself.')
    if (!isHtml(target)) throw new CliError(`${label} isn't an HTML file. Pass an .html file, or a folder with an index.html.`)
    if (matches(basename(target), ENTRY_PATH)) entry = { path: basename(target), abs: target, size: info.size }
  } else {
    const entryPath = entryPathOf(opts.entry)
    const walked = await walkFolder(target, ignoreMatcher(opts.ignore ?? []))
    skipped.push(...walked.skipped)
    for (const file of walked.found) {
      const path = file.path
      const isEntry = path.toLowerCase() === entryPath.toLowerCase()
      if (!matches(path, isEntry ? ENTRY_PATH : undefined)) continue
      if (isEntry) entry = file
      else if (path.toLowerCase() === ENTRY_PATH) skipped.push({ path, reason: `the page itself is ${entryPath}` })
      else if (!hasAllowedType(path)) skipped.push({ path, reason: 'not a type pages can hold' })
      else files.push(file)
    }
  }
  const unmatched = matchers.find((m) => !used.has(m.pattern))
  if (unmatched) throw new CliError(`Nothing in ${label} matches --only ${unmatched.pattern}.`)
  return { entry, files, skipped, total: files.reduce((n, f) => n + f.size, entry?.size ?? 0) }
}

export async function readPage(collected: Collected) {
  const html = await readFile(collected.entry.abs)
  const files = await Promise.all(collected.files.map(async (f) => ({ path: f.path, content: await readFile(f.abs) })))
  return { html, files }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
