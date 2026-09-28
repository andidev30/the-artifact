import { describe, expect, it } from 'vitest'
import { htmlText, MAX_TEXT_CHARS, pageText } from '../../src/files.js'
import { extractText, WORKER_MIN_CHARS, workerState } from '../../src/prepare.js'

describe('the text of a page, for search', () => {
  it('keeps what a reader sees', () => {
    expect(
      htmlText(
        '<!doctype html><html><head><title>Plan</title><style>p { color: red }</style></head>' +
          '<body class="x"><h1>Q3&nbsp;plan</h1><p>Fish &amp; chips &lt;3 &#x41;&#66; &eacute;t&eacute; &bogus;</p>' +
          '<script type="module">alert("<p>no</p>")</script><!-- a note --><noscript>Enable JS</noscript>' +
          '<TEMPLATE><p>later</p></TEMPLATE><textarea>typed</textarea>\u0007</body></html>',
      ),
    ).toBe('Plan Q3 plan Fish & chips <3 AB &eacute;t&eacute; &bogus; typed')
  })

  it('ignores the rest of a document after an element that is never closed', () => {
    expect(htmlText('<p>before</p><script>var a = "<p>after</p>"')).toBe('before')
    expect(htmlText('<p>before</p><!-- open comment <p>after</p>')).toBe('before')
  })

  it("drops code points Postgres can't store", () => {
    expect(htmlText('a&#0;b&#xD800;c&#x110000;d')).toBe('a b c d')
  })

  it('stays fast on input made to be slow', () => {
    for (const evil of [
      '<script>'.repeat(200_000),
      `<script>${'</script '.repeat(200_000)}`,
      '<!--'.repeat(400_000),
      '<a'.repeat(800_000),
      '&#1'.repeat(500_000),
    ]) {
      const started = performance.now()
      htmlText(evil)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })

  it('adds other HTML files by path and stops at the limit', () => {
    expect(
      pageText('<p>home</p>', [
        { path: 'z.html', html: '<p>zed</p>' },
        { path: 'a.html', html: '<p>alpha</p>' },
      ]),
    ).toBe('home alpha zed')
    const long = pageText(`<p>${'word '.repeat(MAX_TEXT_CHARS)}</p>`)
    expect(long.length).toBe(MAX_TEXT_CHARS)
    // Never half of a character outside the Basic Multilingual Plane
    const emoji = pageText(`<p>${'😀'.repeat(MAX_TEXT_CHARS)}</p>`)
    expect(emoji.length).toBe(MAX_TEXT_CHARS)
    expect(emoji.endsWith('😀')).toBe(true)
  })

  it('is the same on a worker thread for large pages', async () => {
    const html = `<p>start</p>${'<div>Some words &amp; more</div>'.repeat(Math.ceil(WORKER_MIN_CHARS / 30))}`
    expect(await extractText(html, [{ path: 'b.html', html: '<p>other</p>' }])).toBe(pageText(html, [{ path: 'b.html', html: '<p>other</p>' }]))
    expect(workerState().workers).toBeGreaterThan(0)
  })
})
