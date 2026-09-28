import { describe, expect, it, vi } from 'vitest'

// docs.ts reads the app's address from window.location when it loads, and tests run in Node
vi.hoisted(() => vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } }))

const { headingId } = await import('./docs')

describe('headingId', () => {
  it('makes a lowercase slug of the words', () => {
    expect(headingId('Connect your agent')).toBe('connect-your-agent')
  })

  it('drops tags, nested ones included', () => {
    expect(headingId('The <code>/mcp</code> endpoint')).toBe('the-mcp-endpoint')
    expect(headingId('a <scr<b>ipt> b')).toBe('a--b')
  })

  it('makes the same anchors as GitHub', () => {
    expect(headingId('<code>update_files</code>')).toBe('update_files')
    expect(headingId('<code>prepare_upload</code> and <code>publish_upload</code>')).toBe('prepare_upload-and-publish_upload')
    expect(headingId('Webhooks can&#39;t reach private networks')).toBe('webhooks-cant-reach-private-networks')
    expect(headingId('Upgrading to 0.6.0')).toBe('upgrading-to-060')
    expect(headingId('3. The seccomp profile')).toBe('3-the-seccomp-profile')
    expect(headingId('&quot;Too many …, try again in …&quot;')).toBe('too-many--try-again-in-')
  })
})
