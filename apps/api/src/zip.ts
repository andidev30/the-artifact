import { promisify } from 'node:util'
import { crc32, deflateRaw, deflateRawSync } from 'node:zlib'

export type ZipEntry = { path: string; content: Buffer }

// MS-DOS date and time. The format has no time zone, so this writes UTC.
function dosDateTime(d: Date) {
  const year = Math.max(d.getUTCFullYear(), 1980)
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

const UTF8_NAMES = 0x0800
const STORE = 0
const DEFLATE = 8
const MAX32 = 0xffffffff
const MAX16 = 0xffff

// One file of an archive: its local header and data, written at `offset`, and its record for the
// central directory. Files that don't shrink, like images and fonts, are stored as they are. Every
// file of a page is far under 4 GB (files.ts), so only the offset can need ZIP64, and only in the
// central directory: a local header doesn't hold its own offset.
function entryRecords(path: string, content: Buffer, deflated: Buffer, modified: Date, offset: number) {
  const { time, date } = dosDateTime(modified)
  const name = Buffer.from(path, 'utf8')
  const method = deflated.length < content.length ? DEFLATE : STORE
  const data = method === DEFLATE ? deflated : content
  const crc = crc32(content)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(UTF8_NAMES, 6)
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)

  const zip64 = offset >= MAX32
  const extra = Buffer.alloc(zip64 ? 12 : 0)
  if (zip64) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(8, 2)
    extra.writeBigUInt64LE(BigInt(offset), 4)
  }
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(zip64 ? 45 : 20, 4)
  central.writeUInt16LE(zip64 ? 45 : 20, 6)
  central.writeUInt16LE(UTF8_NAMES, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(extra.length, 30)
  central.writeUInt32LE(zip64 ? MAX32 : offset, 42)

  return { local: Buffer.concat([local, name, data]), central: Buffer.concat([central, name, extra]) }
}

// The end of an archive whose central directory `directory` starts at `offset`. From 65,535 files
// or 4 GB on it adds the ZIP64 records, which unzip, 7-Zip and the macOS and Windows archivers read.
export function zipEnd(entries: number, directory: Buffer, offset: number): Buffer {
  const zip64 = entries >= MAX16 || offset >= MAX32 || directory.length >= MAX32
  const parts = [directory]
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(entries), 24)
    record.writeBigUInt64LE(BigInt(entries), 32)
    record.writeBigUInt64LE(BigInt(directory.length), 40)
    record.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
    locator.writeUInt32LE(1, 16)
    parts.push(record, locator)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64 ? MAX16 : entries, 8)
  end.writeUInt16LE(zip64 ? MAX16 : entries, 10)
  end.writeUInt32LE(zip64 ? MAX32 : directory.length, 12)
  end.writeUInt32LE(zip64 ? MAX32 : offset, 16)
  parts.push(end)
  return Buffer.concat(parts)
}

// A whole archive in memory, for one version of a page
export function zip(entries: ZipEntry[], modified: Date): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const { local, central } = entryRecords(entry.path, entry.content, deflateRawSync(entry.content), modified, offset)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  return Buffer.concat([...locals, zipEnd(entries.length, Buffer.concat(centrals), offset)])
}

const deflateAsync = promisify(deflateRaw)

// An archive written a file at a time, for ones too big to hold in memory (src/exports.ts). `add`
// returns the bytes to append after what was written so far, starting at `offset`; the directory
// records collect until `takeDirectory`. Compresses on libuv's thread pool, so a big archive
// doesn't hold up the event loop.
export class ZipWriter {
  offset: number
  entries: number
  private directory: Buffer[] = []

  constructor(at: { offset: number; entries: number }) {
    this.offset = at.offset
    this.entries = at.entries
  }

  async add(path: string, content: Buffer, modified: Date): Promise<Buffer> {
    const { local, central } = entryRecords(path, content, await deflateAsync(content), modified, this.offset)
    this.directory.push(central)
    this.offset += local.length
    this.entries += 1
    return local
  }

  takeDirectory(): Buffer {
    const out = Buffer.concat(this.directory)
    this.directory = []
    return out
  }
}
