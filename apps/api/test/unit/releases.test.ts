import { describe, expect, it } from 'vitest'
import { compareVersions, newestRelease, parseVersion } from '../../src/releases.js'

function cmp(a: string, b: string) {
  return Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!))
}

describe('compareVersions', () => {
  it('compares numbers, not strings', () => {
    expect(cmp('0.10.0', '0.9.0')).toBe(1)
    expect(cmp('1.0.0', '0.99.99')).toBe(1)
    expect(cmp('0.2.10', '0.2.9')).toBe(1)
    expect(cmp('0.2.0', 'v0.2.0')).toBe(0)
  })

  it('puts a pre-release before its release', () => {
    expect(cmp('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(cmp('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(cmp('1.0.0-rc.1', '0.9.0')).toBe(1)
  })

  it('orders pre-release identifiers as Semantic Versioning does', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 1; i < order.length; i++) expect(cmp(order[i - 1], order[i])).toBe(-1)
  })

  it('ignores build metadata', () => {
    expect(cmp('1.0.0+build.5', '1.0.0')).toBe(0)
  })

  it('rejects what is not a version', () => {
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('01.2.3')).toBeNull()
    expect(parseVersion('cli-v1.2.3')).toBeNull()
  })
})

describe('newestRelease', () => {
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    html_url: `https://github.com/andidev30/the-artifact/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  })

  it('picks the highest version, whatever the order of the list', () => {
    const newest = newestRelease([release('v0.9.0'), release('v0.10.0'), release('v0.2.1')])
    expect(newest).toEqual({ version: '0.10.0', url: 'https://github.com/andidev30/the-artifact/releases/tag/v0.10.0' })
  })

  it('skips pre-releases, drafts and CLI releases', () => {
    const newest = newestRelease([
      release('v0.3.0'),
      release('v0.4.0', { prerelease: true }),
      release('v0.5.0-rc.1'),
      release('v0.6.0', { draft: true }),
      release('cli-v9.0.0'),
    ])
    expect(newest?.version).toBe('0.3.0')
  })

  it('links only to this repository', () => {
    const newest = newestRelease([release('v0.3.0', { html_url: 'https://evil.example/notes' })])
    expect(newest?.url).toBe('https://github.com/andidev30/the-artifact/releases/tag/v0.3.0')
  })

  it('returns null for anything else', () => {
    expect(newestRelease({ message: 'API rate limit exceeded' })).toBeNull()
    expect(newestRelease([])).toBeNull()
  })
})
