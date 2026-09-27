import { crc32, inflateRawSync } from 'node:zlib'

export type Unzipped = { path: string; content: Buffer; method: number; time: number; date: number }

// Reads an archive the way unzip does, from the central directory at its end, and checks every CRC
export function unzip(archive: Buffer): Unzipped[] {
  const end = archive.length - 22
  if (archive.readUInt32LE(end) !== 0x06054b50) throw new Error('No end of central directory')
  const count = archive.readUInt16LE(end + 10)
  let at = archive.readUInt32LE(end + 16)
  const entries: Unzipped[] = []
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad central directory entry')
    const method = archive.readUInt16LE(at + 10)
    const time = archive.readUInt16LE(at + 12)
    const date = archive.readUInt16LE(at + 14)
    const crc = archive.readUInt32LE(at + 16)
    const size = archive.readUInt32LE(at + 20)
    const nameLength = archive.readUInt16LE(at + 28)
    const offset = archive.readUInt32LE(at + 42)
    const path = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')

    if (archive.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Bad local header for ${path}`)
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28)
    const data = archive.subarray(start, start + size)
    const content = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    if (crc32(content) !== crc) throw new Error(`CRC mismatch for ${path}`)
    entries.push({ path, content, method, time, date })
    at += 46 + nameLength
  }
  return entries
}
