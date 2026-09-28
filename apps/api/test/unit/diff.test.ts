import { describe, expect, it } from 'vitest'
import { diffLines, hunks, splitLines, unifiedDiff, type DiffLine } from '../../src/diff.js'

// Length of the longest common subsequence, by dynamic programming: what the shortest edit must keep
function lcs(a: string[], b: string[]) {
  const row = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diag = 0
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1])
      diag = up
    }
  }
  return row[b.length]
}

const sides = (ops: DiffLine[]) => ({
  old: ops.filter((o) => o.kind !== '+').map((o) => o.line),
  new: ops.filter((o) => o.kind !== '-').map((o) => o.line),
})

// A small deterministic random generator, so failures reproduce
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
}

describe('splitLines', () => {
  it('keeps line breaks and a last line without one', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n'])
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('\n\n')).toEqual(['\n', '\n'])
  })
})

describe('diffLines', () => {
  it('finds a shortest edit that turns one list into the other', () => {
    const next = random(42)
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: Math.floor(next() * 30) }, () => 'abcde'[Math.floor(next() * 5)])
      const b = Array.from({ length: Math.floor(next() * 30) }, () => 'abcde'[Math.floor(next() * 5)])
      const ops = diffLines(a, b, 1000)!
      expect(sides(ops)).toEqual({ old: a, new: b })
      expect(ops.filter((o) => o.kind === ' ').length).toBe(lcs(a, b))
    }
  })

  it('handles empty sides', () => {
    expect(diffLines([], [], 10)).toEqual([])
    expect(diffLines([], ['a\n'], 10)).toEqual([{ kind: '+', line: 'a\n' }])
    expect(diffLines(['a\n'], [], 10)).toEqual([{ kind: '-', line: 'a\n' }])
  })

  it('gives up past the edit cap, but not on long unchanged runs', () => {
    const a = Array.from({ length: 50 }, (_, i) => `old ${i}\n`)
    const b = Array.from({ length: 50 }, (_, i) => `new ${i}\n`)
    expect(diffLines(a, b, 99)).toBeNull()
    expect(diffLines(a, b, 100)).toHaveLength(100)
    expect(diffLines([], b, 49)).toBeNull()

    const same = Array.from({ length: 100_000 }, (_, i) => `line ${i}\n`)
    const changed = [...same]
    changed[50_000] = 'changed\n'
    const ops = diffLines(same, changed, 2)!
    expect(ops.filter((o) => o.kind !== ' ')).toEqual([
      { kind: '-', line: 'line 50000\n' },
      { kind: '+', line: 'changed\n' },
    ])
  })
})

describe('hunks', () => {
  it('keeps three lines around each change and joins changes that are close', () => {
    const a = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`)
    const b = [...a]
    b[1] = 'two\n'
    b[7] = 'eight\n'
    b[17] = 'eighteen\n'
    const list = hunks(diffLines(a, b, 100)!)
    expect(list.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 11, 1, 11],
      [15, 6, 15, 6],
    ])
  })
})

describe('unifiedDiff', () => {
  it('writes what diff -u writes', () => {
    const result = unifiedDiff(
      '<h1>Plan</h1>\n<p>Draft</p>\n<footer>x</footer>\n',
      '<h1>Plan</h1>\n<p>Final</p>\n<footer>x</footer>\n',
      { from: 'index.html', to: 'index.html' },
      100,
    )
    expect(result).toEqual({
      additions: 1,
      deletions: 1,
      diff: '--- a/index.html\n+++ b/index.html\n@@ -1,3 +1,3 @@\n <h1>Plan</h1>\n-<p>Draft</p>\n+<p>Final</p>\n <footer>x</footer>\n',
    })
  })

  it('names added and removed files /dev/null on the missing side', () => {
    expect(unifiedDiff('', 'a\nb\n', { from: null, to: 'new.css' }, 100)?.diff).toBe('--- /dev/null\n+++ b/new.css\n@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(unifiedDiff('gone\n', '', { from: 'old.js', to: null }, 100)?.diff).toBe('--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n')
  })

  it('marks a missing newline at the end of a file', () => {
    expect(unifiedDiff('a\nb', 'a\nb\n', { from: 'x.txt', to: 'x.txt' }, 100)?.diff).toBe(
      '--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n',
    )
  })

  it('is empty for the same text, and null past the cap', () => {
    expect(unifiedDiff('same\n', 'same\n', { from: 'a', to: 'a' }, 10)).toEqual({ diff: '', additions: 0, deletions: 0 })
    expect(unifiedDiff('a\nb\nc\n', 'x\ny\nz\n', { from: 'a', to: 'a' }, 5)).toBeNull()
  })
})
