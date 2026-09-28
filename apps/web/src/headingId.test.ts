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
    expect(headingId('a <scr<b>ipt> b')).toBe('a-b')
  })
})
