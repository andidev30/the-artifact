import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ZipWriter, zip, zipEnd } from '../../src/zip.js'
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

  it('writes an archive a file at a time, the same as all at once', async () => {
    const modified = new Date(Date.UTC(2026, 8, 28, 14, 30, 10))
    const files = [
      { path: 'README.txt', content: Buffer.from('hello '.repeat(100)) },
      { path: 'pages/a/versions/1/img.png', content: randomBytes(2048) },
    ]
    const writer = new ZipWriter({ offset: 0, entries: 0 })
    const first = await writer.add(files[0].path, files[0].content, modified)
    // A later step picks up where the last one saved
    const next = new ZipWriter({ offset: writer.offset, entries: writer.entries })
    const second = await next.add(files[1].path, files[1].content, modified)
    const directory = Buffer.concat([writer.takeDirectory(), next.takeDirectory()])
    const archive = Buffer.concat([first, second, zipEnd(next.entries, directory, next.offset)])
    expect(archive.equals(zip(files, modified))).toBe(true)
  })

  it('adds the ZIP64 records past 65,535 files or 4 GB', () => {
    const small = zipEnd(3, Buffer.alloc(10), 1000)
    expect(small.length).toBe(10 + 22)

    const end = zipEnd(70_000, Buffer.alloc(10), 5_000_000_000)
    const record = end.subarray(10, 66)
    expect(record.readUInt32LE(0)).toBe(0x06064b50)
    expect(record.readBigUInt64LE(32)).toBe(70_000n)
    expect(record.readBigUInt64LE(40)).toBe(10n)
    expect(record.readBigUInt64LE(48)).toBe(5_000_000_000n)
    const locator = end.subarray(66, 86)
    expect(locator.readUInt32LE(0)).toBe(0x07064b50)
    expect(locator.readBigUInt64LE(8)).toBe(5_000_000_010n)
    const eocd = end.subarray(86)
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50)
    expect(eocd.readUInt16LE(10)).toBe(0xffff)
    expect(eocd.readUInt32LE(16)).toBe(0xffffffff)
  })

  it('gives a file past 4 GB into the archive its offset in a ZIP64 field', async () => {
    const writer = new ZipWriter({ offset: 5_000_000_000, entries: 0 })
    await writer.add('late.txt', Buffer.from('late'), new Date())
    const record = writer.takeDirectory()
    expect(record.readUInt32LE(42)).toBe(0xffffffff)
    const extra = record.subarray(46 + 'late.txt'.length)
    expect(extra.readUInt16LE(0)).toBe(1)
    expect(extra.readBigUInt64LE(4)).toBe(5_000_000_000n)
  })
})
