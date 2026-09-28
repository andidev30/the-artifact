import { describe, expect, it } from 'vitest'
import { helperOffset, withFrameHelper } from '../../src/frame-helper.js'

const BOM = String.fromCharCode(0xfeff)
const OPEN = '<script>'
const CLOSE = '</script>'
const start = (html: string) => withFrameHelper(html).indexOf(OPEN)

// The helper's script element, taken out again by position rather than by a pattern
function withoutHelper(out: string) {
  const from = out.indexOf(OPEN)
  const to = out.indexOf(CLOSE, from) + CLOSE.length
  return out.slice(0, from) + out.slice(to)
}

describe('withFrameHelper', () => {
  it('goes right after the doctype, so the page keeps its rendering mode', () => {
    expect(start('<!DOCTYPE html><html><body>x</body></html>')).toBe('<!DOCTYPE html>'.length)
    expect(start('\n  <!doctype html>\n<p>x')).toBe('\n  <!doctype html>'.length)
    expect(start('<!-- built by an agent --><!doctype html><p>x')).toBe('<!-- built by an agent --><!doctype html>'.length)
    expect(start(`${BOM}<!doctype html><p>x`)).toBe(`${BOM}<!doctype html>`.length)
  })

  it('reads doctypes and comments in any case and shape', () => {
    const legacy = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">'
    expect(helperOffset(`${legacy}<P>x`)).toBe(legacy.length)
    expect(helperOffset('<!DocType html >x')).toBe('<!DocType html >'.length)
    expect(helperOffset('\t\f\r\n<!doctype html>')).toBe('\t\f\r\n<!doctype html>'.length)
    expect(helperOffset('<!--> <!---> <!-- a -- b --><!doctype html>x')).toBe('<!--> <!---> <!-- a -- b --><!doctype html>'.length)
    // No doctype first, or one that never closes: the helper goes first
    expect(helperOffset('<p>x</p><!doctype html>')).toBe(0)
    expect(helperOffset('<!-- never closed <!doctype html>')).toBe(0)
    expect(helperOffset('<!doctype html')).toBe(0)
    expect(helperOffset('<!doc>')).toBe(0)
  })

  it('goes first when there is no doctype, after a byte order mark', () => {
    expect(start('<h1>Hi</h1>')).toBe(0)
    expect(start(`${BOM}<h1>Hi</h1>`)).toBe(1)
    expect(start('')).toBe(0)
  })

  it('stays fast on HTML made to slow it down', () => {
    const inputs = [
      `<!--${'--><!--'.repeat(100_000)}`,
      `${'<!--'.repeat(100_000)}`,
      `${'<!---->'.repeat(100_000)}x`,
      `${' '.repeat(200_000)}<!doctype${' '.repeat(200_000)}`,
    ]
    for (const html of inputs) {
      const began = performance.now()
      helperOffset(html)
      expect(performance.now() - began).toBeLessThan(100)
    }
  })

  it('leaves the page itself as it was', () => {
    const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><h1>Hi</h1>'
    const out = withFrameHelper(html)
    expect(withoutHelper(out)).toBe(html)
    // One script element, which never closes early
    expect(out.toLowerCase().split('</script').length - 1).toBe(1)
  })

  it('is valid JavaScript', () => {
    const out = withFrameHelper('')
    const source = out.slice(OPEN.length, out.length - CLOSE.length)
    expect(() => new Function(source)).not.toThrow()
  })
})
