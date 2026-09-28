import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type FileInput, prepareContent, PublishError } from '../../src/files.js'
import { prepare, WORKER_MIN_CHARS, workerState } from '../../src/prepare.js'

const HTML = `<!doctype html><title>Large</title>${'<p>Numbers for the week: 42 signups, 7 refunds. Déjà vu ✓</p>\n'.repeat(8000)}`
const BINARY = randomBytes(300 * 1024)
const FILES: FileInput[] = [
  { path: 'img/photo.png', content: BINARY.toString('base64'), encoding: 'base64' },
  // Wrapped base64, as some encoders write it
  { path: 'img/wrapped.png', content: BINARY.subarray(0, 3000).toString('base64').replace(/.{76}/g, '$&\n'), encoding: 'base64' },
  { path: 'css/site.css', content: `body { color: rgb(1, 2, 3) }\n${'.x { margin: 0 }\n'.repeat(5000)}` },
  { path: 'app.js', content: 'console.log("ünïcode")' },
  // A file part of a form arrives as bytes
  { path: 'data/raw.json', content: new Uint8Array(Buffer.from('[1,2,3]')) },
  { path: 'empty.txt', content: '' },
]

function mainThreadError(html: string, files: FileInput[]): Error | null {
  try {
    prepareContent(html, files)
  } catch (err) {
    return err as Error
  }
  return null
}

async function workerError(html: string, files: FileInput[]): Promise<Error | null> {
  try {
    await prepare(html, files)
  } catch (err) {
    return err as Error
  }
  return null
}

describe('preparing large pages on worker threads', () => {
  it('gives the same bytes, sizes and hashes as the main thread', async () => {
    expect(HTML.length).toBeGreaterThan(WORKER_MIN_CHARS)
    const expected = prepareContent(HTML, FILES)
    const got = await prepare(HTML, FILES)
    expect(workerState().disabled).toBe(false)
    expect(workerState().workers).toBeGreaterThan(0)

    expect(got.htmlSha256).toBe(expected.htmlSha256)
    expect(got.htmlSize).toBe(expected.htmlSize)
    expect(Buffer.isBuffer(got.html)).toBe(true)
    expect(got.html.equals(expected.html)).toBe(true)
    expect(got.files.map(({ content, ...meta }) => meta)).toEqual(expected.files.map(({ content, ...meta }) => meta))
    for (const [i, file] of got.files.entries()) {
      expect(Buffer.isBuffer(file.content)).toBe(true)
      expect(file.content.equals(expected.files[i].content)).toBe(true)
    }
    expect(got.files[0].content.equals(BINARY)).toBe(true)
  })

  it('refuses what the main thread refuses, with the same message', async () => {
    const cases: [string, FileInput[]][] = [
      [HTML, [{ path: 'img/bad.png', content: `${BINARY.toString('base64')}!`, encoding: 'base64' }]],
      [HTML, [{ path: 'img/raw.png', content: 'x'.repeat(WORKER_MIN_CHARS) }]],
      [HTML, [{ path: '../up.css', content: 'x'.repeat(WORKER_MIN_CHARS) }]],
      [HTML, [{ path: 'big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) }]],
      [`<p>${'x'.repeat(2 * 1024 * 1024)}</p>`, []],
    ]
    for (const [html, files] of cases) {
      const expected = mainThreadError(html, files)
      expect(expected).toBeInstanceOf(PublishError)
      const got = await workerError(html, files)
      expect(got).toBeInstanceOf(PublishError)
      expect(got?.message).toBe(expected?.message)
    }
    expect(workerState().disabled).toBe(false)
  })

  it('prepares many at once, each with its own result, on at most four threads', async () => {
    const pages = Array.from({ length: 12 }, (_, n) => `${HTML}<!-- ${n} -->`)
    const results = await Promise.all(pages.map((html) => prepare(html, FILES)))
    expect(results.map((r) => r.htmlSha256)).toEqual(pages.map((html) => prepareContent(html, []).htmlSha256))
    expect(workerState().workers).toBeLessThanOrEqual(4)
  })

  it('keeps small pages on the main thread', async () => {
    const files: FileInput[] = [{ path: 'a.css', content: 'a {}' }]
    expect(await prepare('<p>small</p>', files)).toEqual(prepareContent('<p>small</p>', files))
  })
})
