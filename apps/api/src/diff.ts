// Line diffs for comparing two versions of a page (Myers' O(ND) algorithm), with no dependency.
// Imports nothing, so unit tests can run it without services.

export type DiffLine = { kind: ' ' | '-' | '+'; line: string }

// Lines with their line break, so a missing newline at the end of a file counts as a change
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

// The shortest list of kept, removed and added lines turning a into b, or null when that takes more
// than maxEdits removed and added lines together. Time is O((n + m) · edits) and memory O(edits²), so
// maxEdits is what keeps a request from running long on two unrelated files.
export function diffLines(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middle = shortestEdit(a.slice(start, endA), b.slice(start, endB), maxEdits)
  if (!middle) return null
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ kind: ' ', line: a[i] })
  for (const op of middle) out.push(op)
  for (let i = endA; i < a.length; i++) out.push({ kind: ' ', line: a[i] })
  return out
}

function shortestEdit(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  const n = a.length
  const m = b.length
  if (n + m > maxEdits && (n === 0 || m === 0)) return null
  if (n === 0) return b.map((line) => ({ kind: '+', line }))
  if (m === 0) return a.map((line) => ({ kind: '-', line }))

  // Compare numbers rather than strings in the inner loop
  const ids = new Map<string, number>()
  const id = (line: string) => {
    let n = ids.get(line)
    if (n === undefined) {
      n = ids.size
      ids.set(line, n)
    }
    return n
  }
  const xs = Int32Array.from(a, id)
  const ys = Int32Array.from(b, id)

  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  // v[offset + k] is the furthest x reached on diagonal k = x - y
  const v = new Int32Array(2 * max + 3)
  // Before round d, the part of v that round reads (diagonals -d-1 … d+1), for walking back
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && xs[x] === ys[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return walkBack(a, b, trace, d)
    }
  }
  return null
}

function walkBack(a: string[], b: string[], trace: Int32Array[], edits: number): DiffLine[] {
  const out: DiffLine[] = []
  let x = a.length
  let y = b.length
  for (let d = edits; d > 0; d--) {
    const before = trace[d]
    const at = (k: number) => before[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ kind: ' ', line: a[--x] })
      y--
    }
    if (x === prevX) out.push({ kind: '+', line: b[--y] })
    else out.push({ kind: '-', line: a[--x] })
  }
  while (x > 0 && y > 0) {
    out.push({ kind: ' ', line: a[--x] })
    y--
  }
  return out.reverse()
}

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }

// Changed lines grouped with `context` unchanged lines around them, as in `diff -u`
export function hunks(lines: DiffLine[], context = 3): Hunk[] {
  const n = lines.length
  // Distance to the nearest change before and after each line
  const keep = new Uint8Array(n)
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== ' ') last = i
    if (i - last <= context) keep[i] = 1
  }
  last = Infinity
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].kind !== ' ') last = i
    if (last - i <= context) keep[i] = 1
  }

  const out: Hunk[] = []
  let oldBefore = 0
  let newBefore = 0
  let current: Hunk | null = null
  for (let i = 0; i < n; i++) {
    const op = lines[i]
    if (keep[i]) {
      if (!current) {
        current = { oldStart: oldBefore, oldLines: 0, newStart: newBefore, newLines: 0, lines: [] }
        out.push(current)
      }
      current.lines.push(op)
      if (op.kind !== '+') current.oldLines++
      if (op.kind !== '-') current.newLines++
    } else current = null
    if (op.kind !== '+') oldBefore++
    if (op.kind !== '-') newBefore++
  }
  // Lines count from 1; an empty side names the line before it, 0 for the start of the file
  for (const h of out) {
    if (h.oldLines) h.oldStart++
    if (h.newLines) h.newStart++
  }
  return out
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)

export function formatHunks(list: Hunk[]): string {
  let out = ''
  for (const h of list) {
    out += `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@\n`
    for (const { kind, line } of h.lines) {
      out += line.endsWith('\n') ? `${kind}${line}` : `${kind}${line}\n\\ No newline at end of file\n`
    }
  }
  return out
}

export type TextDiff = { diff: string; additions: number; deletions: number }

// A unified diff of two texts, as `diff -u` writes it, with --- and +++ lines naming the old and new
// file (null for a file that isn't there). Null when it would take more than maxEdits changed lines.
export function unifiedDiff(
  oldText: string,
  newText: string,
  names: { from: string | null; to: string | null },
  maxEdits: number,
  context = 3,
): TextDiff | null {
  const lines = diffLines(splitLines(oldText), splitLines(newText), maxEdits)
  if (!lines) return null
  let additions = 0
  let deletions = 0
  for (const op of lines) {
    if (op.kind === '+') additions++
    else if (op.kind === '-') deletions++
  }
  if (!additions && !deletions) return { diff: '', additions, deletions }
  const head = `--- ${names.from === null ? '/dev/null' : `a/${names.from}`}\n+++ ${names.to === null ? '/dev/null' : `b/${names.to}`}\n`
  return { diff: head + formatHunks(hunks(lines, context)), additions, deletions }
}
