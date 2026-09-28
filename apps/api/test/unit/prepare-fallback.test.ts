import { describe, expect, it, vi } from 'vitest'
import { prepareContent } from '../../src/files.js'
import { prepare, workerState } from '../../src/prepare.js'

// A platform without worker threads
vi.mock('node:worker_threads', async (original) => ({
  ...(await original<typeof import('node:worker_threads')>()),
  Worker: class {
    constructor() {
      throw new Error('No threads here')
    }
  },
}))

describe('preparing large pages without worker threads', () => {
  it('prepares them on the main thread instead', async () => {
    const html = `<p>${'x'.repeat(512 * 1024)}</p>`
    const files = [{ path: 'img/a.png', content: Buffer.from('png').toString('base64'), encoding: 'base64' as const }]
    expect(await prepare(html, files)).toEqual(prepareContent(html, files))
    expect(workerState()).toEqual({ workers: 0, disabled: true })
    await expect(prepare(html, [{ path: 'img/a.png', content: 'png' }])).rejects.toThrow('"img/a.png" is a binary file: send it with encoding "base64".')
  })
})
