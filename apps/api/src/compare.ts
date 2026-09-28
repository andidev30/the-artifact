import { versionFiles, type Version } from './artifacts.js'
import { unifiedDiff } from './diff.js'
import { ENTRY_PATH, isText } from './files.js'
import { getBlob } from './storage.js'

// Comparing two versions of a page: which files were added, removed or changed, and a line diff of
// the text files. Diffs cost time and memory on the server, so each is capped, and so is the whole answer.

// Text files bigger than this on either side show as changed without a diff
export const MAX_DIFF_FILE_BYTES = 200 * 1024
// More changed lines than this in one file: shown as changed without a diff
export const MAX_DIFF_EDITS = 2000
// Diffing stops once this much text was read, or this much diff written, for one comparison
export const MAX_DIFF_INPUT_BYTES = 2 * 1024 * 1024
export const MAX_DIFF_OUTPUT_BYTES = 1024 * 1024

// Why a changed file has no diff: not text, too big, too many changed lines, or the comparison's budget ran out
export type Omitted = 'binary' | 'large' | 'complex' | 'budget'

export type FileSide = { size: number; contentType: string }

export type ComparedFile = {
  path: string
  status: 'added' | 'removed' | 'changed'
  from: FileSide | null
  to: FileSide | null
  diff: string | null
  additions: number | null
  deletions: number | null
  omitted: Omitted | null
}

export type Comparison = { from: number; to: number; files: ComparedFile[]; unchanged: number }

type Stored = FileSide & { sha256: string }

async function filesOf(v: Version): Promise<Map<string, Stored>> {
  const files = new Map<string, Stored>([[ENTRY_PATH, { size: v.htmlSize, contentType: 'text/html; charset=utf-8', sha256: v.htmlSha256 }]])
  for (const f of (await versionFiles(v)).values()) files.set(f.path, { size: f.size, contentType: f.contentType, sha256: f.sha256 })
  return files
}

async function textOf(file: Stored | undefined): Promise<string> {
  if (!file) return ''
  const content = await getBlob(file.sha256)
  if (!content) throw new Error(`A file is missing from storage (${file.sha256})`)
  return content.toString('utf8')
}

// Both versions must have been read from the database by this request (see versionFiles)
export async function compareVersions(
  from: Version,
  to: Version,
  limits = { input: MAX_DIFF_INPUT_BYTES, output: MAX_DIFF_OUTPUT_BYTES },
): Promise<Comparison> {
  const [before, after] = await Promise.all([filesOf(from), filesOf(to)])
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (a === ENTRY_PATH ? -1 : b === ENTRY_PATH ? 1 : a < b ? -1 : a > b ? 1 : 0))
  const files: ComparedFile[] = []
  let unchanged = 0
  let read = 0
  let written = 0
  // One file at a time, so no more than two files' text is in memory at once
  for (const path of paths) {
    const a = before.get(path)
    const b = after.get(path)
    if (a && b && a.sha256 === b.sha256) {
      unchanged++
      continue
    }
    const entry: ComparedFile = {
      path,
      status: !a ? 'added' : !b ? 'removed' : 'changed',
      from: a ? { size: a.size, contentType: a.contentType } : null,
      to: b ? { size: b.size, contentType: b.contentType } : null,
      diff: null,
      additions: null,
      deletions: null,
      omitted: null,
    }
    files.push(entry)
    const size = (a?.size ?? 0) + (b?.size ?? 0)
    if ((a && !isText(a.contentType)) || (b && !isText(b.contentType))) entry.omitted = 'binary'
    else if ((a?.size ?? 0) > MAX_DIFF_FILE_BYTES || (b?.size ?? 0) > MAX_DIFF_FILE_BYTES) entry.omitted = 'large'
    else if (read + size > limits.input || written >= limits.output) entry.omitted = 'budget'
    if (entry.omitted) continue

    read += size
    const [oldText, newText] = await Promise.all([textOf(a), textOf(b)])
    const result = unifiedDiff(oldText, newText, { from: a ? path : null, to: b ? path : null }, MAX_DIFF_EDITS)
    if (!result) {
      entry.omitted = 'complex'
      continue
    }
    entry.additions = result.additions
    entry.deletions = result.deletions
    if (written + result.diff.length > limits.output) {
      entry.omitted = 'budget'
      continue
    }
    written += result.diff.length
    entry.diff = result.diff
  }
  return { from: from.version, to: to.version, files, unchanged }
}

export const OMITTED_TEXT: Record<Omitted, string> = {
  binary: 'Not a text file, so there is no line diff.',
  large: `Bigger than ${MAX_DIFF_FILE_BYTES / 1024} KB, so there is no line diff.`,
  complex: `More than ${MAX_DIFF_EDITS} lines changed, so there is no line diff.`,
  budget: 'No line diff: this comparison already shows as much as it can. Compare fewer changes to see it.',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function summary(c: Comparison): string {
  const by = (status: ComparedFile['status']) => c.files.filter((f) => f.status === status).length
  const parts = [`${by('changed')} changed`, `${by('added')} added`, `${by('removed')} removed`, `${c.unchanged} unchanged`]
  return c.files.length ? `${count(c.files.length, 'file differs', 'files differ')}: ${parts.join(', ')}.` : 'The two versions are the same.'
}

// For agents: the comparison as plain text, with each diff as `diff -u` writes it
export function comparisonText(title: string, c: Comparison): string {
  const lines = [`Changes in "${title}" from version ${c.from} to version ${c.to}. ${summary(c)}`]
  for (const f of c.files) {
    const size =
      f.status === 'added'
        ? formatBytes(f.to!.size)
        : f.status === 'removed'
          ? formatBytes(f.from!.size)
          : `${formatBytes(f.from!.size)} → ${formatBytes(f.to!.size)}`
    const lineCounts = f.additions !== null ? `, +${f.additions} -${f.deletions} lines` : ''
    lines.push('', `${f.status[0].toUpperCase()}${f.status.slice(1)}: ${f.path} (${(f.to ?? f.from)!.contentType.split(';')[0]}, ${size}${lineCounts})`)
    if (f.diff) lines.push(f.diff.replace(/\n$/, ''))
    else if (f.omitted) lines.push(OMITTED_TEXT[f.omitted])
  }
  return lines.join('\n')
}
