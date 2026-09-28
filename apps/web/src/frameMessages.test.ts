import { describe, expect, it } from 'vitest'
import { cleanSnippet, describeHover, htmlPath, parseFrameMessage } from './frameMessages'

const picked = { artifact: 1, type: 'picked', selector: '#chart > h2', snippet: 'Revenue', path: 'index.html', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } }

describe('parseFrameMessage', () => {
  it('reads the messages the helper sends', () => {
    expect(parseFrameMessage({ artifact: 1, type: 'ready', path: 'index.html' })).toEqual({ type: 'ready', path: 'index.html' })
    expect(parseFrameMessage({ artifact: 1, type: 'cancel' })).toEqual({ type: 'cancel' })
    expect(parseFrameMessage(picked)).toEqual({
      type: 'picked',
      anchor: { selector: '#chart > h2', snippet: 'Revenue', path: 'index.html', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
    })
    expect(parseFrameMessage({ artifact: 1, type: 'hover', snippet: 'Revenue', tag: 'H2', index: 3, count: 20 })).toEqual({
      type: 'hover',
      snippet: 'Revenue',
      tag: 'h2',
      index: 3,
      count: 20,
    })
    expect(
      parseFrameMessage({
        artifact: 1,
        type: 'located',
        path: 'docs/team.html',
        pins: [
          { key: 0, rect: { x: 10, y: -40, w: 200, h: 30 } },
          { key: 1, rect: null },
        ],
      }),
    ).toEqual({
      type: 'located',
      path: 'docs/team.html',
      pins: [
        { key: 0, rect: { x: 10, y: -40, w: 200, h: 30 } },
        { key: 1, rect: null },
      ],
    })
  })

  it('ignores anything that is not one of them', () => {
    for (const data of [
      null,
      'picked',
      42,
      [picked],
      { ...picked, artifact: 2 },
      { ...picked, artifact: '1' },
      { ...picked, type: 'eval' },
      { ...picked, type: 'toString' },
      { artifact: 1, type: 'ready' },
      { artifact: 1, type: 'ready', path: '../../api/me.html' },
      { artifact: 1, type: 'ready', path: 'style.css' },
      { artifact: 1, type: 'ready', path: 'https://evil.example/x.html' },
      { ...picked, selector: '' },
      { ...picked, selector: 'a'.repeat(501) },
      { ...picked, selector: 'h1\u0000' },
      { ...picked, selector: { toString: () => 'h1' } },
      { ...picked, path: '/index.html' },
      { artifact: 1, type: 'hover', snippet: 'x', tag: 'p', index: -1, count: 2 },
      { artifact: 1, type: 'hover', snippet: 'x', tag: 'p', index: 1.5, count: 2 },
      { artifact: 1, type: 'located', path: 'index.html', pins: 'all' },
      { artifact: 1, type: 'located', path: 'index.html', pins: [{ key: 'a', rect: null }] },
      { artifact: 1, type: 'located', path: 'index.html', pins: [{ key: 500, rect: null }] },
      { artifact: 1, type: 'located', path: 'index.html', pins: Array.from({ length: 201 }, (_, key) => ({ key: key % 200, rect: null })) },
    ]) {
      expect(parseFrameMessage(data), JSON.stringify(data)).toBeNull()
    }
  })

  it('drops a position it cannot use rather than the message', () => {
    expect(parseFrameMessage({ ...picked, rect: { x: 2, y: 0, w: 0, h: 0 } })).toMatchObject({ anchor: { rect: null } })
    expect(parseFrameMessage({ ...picked, rect: 'top' })).toMatchObject({ anchor: { rect: null } })
    const located = parseFrameMessage({ artifact: 1, type: 'located', path: 'index.html', pins: [{ key: 0, rect: { x: Number.NaN, y: 0, w: 1, h: 1 } }] })
    expect(located).toEqual({ type: 'located', path: 'index.html', pins: [{ key: 0, rect: null }] })
    const far = parseFrameMessage({ artifact: 1, type: 'located', path: 'index.html', pins: [{ key: 0, rect: { x: 1e9, y: 0, w: 1, h: 1 } }] })
    expect(far).toEqual({ type: 'located', path: 'index.html', pins: [{ key: 0, rect: null }] })
  })

  it('cleans the text it carries', () => {
    expect(parseFrameMessage({ ...picked, snippet: '  Revenue\n\tby\u0007 month ' })).toMatchObject({ anchor: { snippet: 'Revenue by month' } })
    expect(parseFrameMessage({ ...picked, snippet: 7 })).toMatchObject({ anchor: { snippet: '' } })
    expect(parseFrameMessage({ artifact: 1, type: 'hover', snippet: 'x', tag: '<img onerror>', index: 1, count: 1 })).toMatchObject({ tag: '' })
  })
})

describe('cleanSnippet', () => {
  it('keeps text up to 200 characters', () => {
    expect(cleanSnippet('a'.repeat(200))).toHaveLength(200)
    const long = cleanSnippet('b'.repeat(5000))
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('htmlPath', () => {
  it('accepts the HTML files a page can have', () => {
    expect(htmlPath('index.html')).toBe('index.html')
    expect(htmlPath('pages/Team.HTM')).toBe('pages/Team.HTM')
    expect(htmlPath('pages/../index.html')).toBeNull()
    expect(htmlPath('.hidden.html')).toBeNull()
    expect(htmlPath('a b.html')).toBeNull()
  })
})

describe('describeHover', () => {
  it('says what is highlighted and where in the list it is', () => {
    expect(describeHover({ snippet: 'Revenue', tag: 'h2', index: 3, count: 20 })).toBe('Heading: Revenue. 3 of 20.')
    expect(describeHover({ snippet: '', tag: 'div', index: 1, count: 2 })).toBe('Element. 1 of 2.')
  })
})
