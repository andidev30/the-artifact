import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { zip } from '../../src/zip.js'
import { unzip } from '../unzip.js'

describe('zip', () => {
  it('round-trips text and binary files with their paths', () => {
    const html = Buffer.from(`<!doctype html>${'<p>repeated</p>'.repeat(200)}`)
    const image = randomBytes(4096)
    const entries = unzip(
      zip(
        [
          { path: 'index.html', content: html },
          { path: 'img/café.png', content: image },
          { path: 'empty.txt', content: Buffer.alloc(0) },
        ],
        new Date(Date.UTC(2026, 8, 28, 14, 30, 10)),
      ),
    )
    expect(entries.map((e) => e.path)).toEqual(['index.html', 'img/café.png', 'empty.txt'])
    expect(entries[0].content.equals(html)).toBe(true)
    expect(entries[1].content.equals(image)).toBe(true)
    expect(entries[2].content.length).toBe(0)
    // Text shrinks, random bytes don't, so they are stored as they are
    expect(entries[0].method).toBe(8)
    expect(entries[1].method).toBe(0)
  })

  it('stamps the time in MS-DOS format', () => {
    const [entry] = unzip(zip([{ path: 'a.txt', content: Buffer.from('a') }], new Date(Date.UTC(2026, 8, 28, 14, 30, 10))))
    expect(entry.date).toBe(((2026 - 1980) << 9) | (9 << 5) | 28)
    expect(entry.time).toBe((14 << 11) | (30 << 5) | 5)
  })

  it('writes an empty archive', () => {
    expect(unzip(zip([], new Date()))).toEqual([])
  })
})
