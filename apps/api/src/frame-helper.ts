import { createHash } from 'node:crypto'

// The comment helper: a small script the content server adds to a page's HTML files when the address
// asks for it (/v/<version>/[~token/]~comments/…), so the app's viewer can let people pick an element to
// comment on and draw pins over the elements comments are about.
//
// Trust model (see "Comments on an element" in docs/security.md):
// - It runs inside the page's sandboxed frame, as part of the page. It has no more access than the
//   page's own scripts, which can read, change, remove or imitate it. So it adds nothing a page couldn't
//   already do: any page can already post messages to the window that frames it.
// - It talks to the app only with postMessage. The app accepts messages only from its own frame's
//   window, checks their shape and sizes, and uses what they carry as data: a selector, some text and
//   numbers, shown as text and stored only after the person confirms a comment in the app's own UI.
// - The app sends it selectors and texts of the comments' anchors (never bodies, authors or ids), which
//   came from this page in the first place.
//
// It is plain ES2017 in a string rather than a function turned into a string, so no bundler or
// transpiler (tsx, vitest) can add helpers that wouldn't exist inside the page.
export const HELPER_MARK = '~comments'

const SCRIPT = String.raw`(function () {
  'use strict'
  if (window.parent === window || window.__artifactCommentHelper) return
  window.__artifactCommentHelper = true
  var parent = window.parent
  var MARK = '/${HELPER_MARK}/'
  var MAX_SELECTOR = 500
  var MAX_SNIPPET = 200
  var CANDIDATES = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre,figure,figcaption,img,svg,canvas,video,picture,table,caption,th,td,button,a[href],label,input,select,textarea,summary,section,article,aside,nav,header,footer,form,[role],[id]'

  function send(msg) {
    msg.artifact = 1
    try { parent.postMessage(msg, '*') } catch (e) {}
  }

  function currentPath() {
    var p = location.pathname
    var i = p.indexOf(MARK)
    var rest = i === -1 ? '' : p.slice(i + MARK.length)
    try { rest = decodeURIComponent(rest) } catch (e) { rest = '' }
    return rest || 'index.html'
  }

  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s)
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c })
  }

  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1 } catch (e) { return false }
  }

  function selectorFor(el) {
    var parts = []
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && unique('#' + esc(el.id))) { parts.unshift('#' + esc(el.id)); break }
      if (el === document.body) { parts.unshift('body'); break }
      var tag = el.localName
      var n = 1
      var sib = el
      while ((sib = sib.previousElementSibling)) if (sib.localName === tag) n++
      parts.unshift(esc(tag) + ':nth-of-type(' + n + ')')
      el = el.parentElement
    }
    return parts.join(' > ')
  }

  function snippetOf(el) {
    var t = ''
    if (el.localName === 'img') t = el.getAttribute('alt') || ''
    else if (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select') t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
    else t = el.innerText || el.textContent || ''
    if (!t) t = el.getAttribute('aria-label') || el.getAttribute('title') || ''
    t = String(t).replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
    return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET - 1) + '…' : t
  }

  function visible(el) {
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function candidates() {
    var all = document.querySelectorAll(CANDIDATES)
    var out = []
    for (var i = 0; i < all.length && out.length < 2000; i++) {
      var el = all[i]
      if (el === box || (el.closest && el.closest('svg') && el.localName !== 'svg')) continue
      if (visible(el)) out.push(el)
    }
    return out
  }

  function box4(r) {
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }

  // Where the element is on the whole page, as fractions of its width and height
  function pageRect(el) {
    var r = el.getBoundingClientRect()
    var d = document.documentElement
    var W = Math.max(d.scrollWidth, 1)
    var H = Math.max(d.scrollHeight, 1)
    function f(v) { return Math.min(1, Math.max(0, Math.round(v * 10000) / 10000)) }
    return { x: f((r.left + window.scrollX) / W), y: f((r.top + window.scrollY) / H), w: f(r.width / W), h: f(r.height / H) }
  }

  // Picking
  var picking = false
  var box = null
  var current = null
  var list = []
  var index = -1
  var savedCursor = ''

  function highlight(el) {
    current = el
    if (!box) return
    if (!el) { box.style.display = 'none'; return }
    var r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = r.left - 2 + 'px'
    box.style.top = r.top - 2 + 'px'
    box.style.width = r.width + 4 + 'px'
    box.style.height = r.height + 4 + 'px'
  }

  function startPick() {
    if (picking) return
    picking = true
    box = document.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.setAttribute('data-artifact-helper', '')
    box.style.cssText = 'all:initial;position:fixed;display:none;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid #1f3b73;background:rgba(255,214,10,0.25);border-radius:2px'
    document.documentElement.appendChild(box)
    savedCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'
    list = candidates()
    index = -1
    for (var i = 0; i < EVENTS.length; i++) window.addEventListener(EVENTS[i], onEvent, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
  }

  function stopPick() {
    if (!picking) return
    picking = false
    for (var i = 0; i < EVENTS.length; i++) window.removeEventListener(EVENTS[i], onEvent, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', onScroll, true)
    if (box && box.parentNode) box.parentNode.removeChild(box)
    box = null
    current = null
    document.documentElement.style.cursor = savedCursor
  }

  function choose(el) {
    if (!el || el === document.documentElement) return
    var msg = { type: 'picked', selector: selectorFor(el), snippet: snippetOf(el), rect: pageRect(el), path: currentPath() }
    stopPick()
    send(msg)
  }

  var EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'pointermove', 'mousemove']

  // While picking, the page's own handlers don't see pointer events, so a click picks instead of
  // following a link or pressing a button
  function onEvent(e) {
    var t = e.target
    if (e.type === 'pointermove' || e.type === 'mousemove') {
      if (t && t.nodeType === 1 && t !== box) highlight(t)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.type === 'click' && t && t.nodeType === 1) choose(t)
  }

  function move(to) {
    if (!list.length) return
    index = (to + list.length) % list.length
    var el = list[index]
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch (e) {}
    highlight(el)
    send({ type: 'hover', snippet: snippetOf(el), tag: el.localName, index: index + 1, count: list.length })
  }

  function onKey(e) {
    var k = e.key
    if (k === 'Escape') { stopPick(); send({ type: 'cancel' }) }
    else if (k === 'ArrowDown' || k === 'ArrowRight') move(index + 1)
    else if (k === 'ArrowUp' || k === 'ArrowLeft') move(index < 0 ? -1 : index - 1)
    else if (k === 'Home') move(0)
    else if (k === 'End') move(list.length - 1)
    else if ((k === 'Enter' || k === ' ') && current) choose(current)
    else return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }

  function onScroll() {
    if (current) highlight(current)
  }

  // Pins: the app asks where its anchors' elements are, and hears again whenever they may have moved
  var anchors = []
  var pending = false

  function byText(text) {
    var all = candidates()
    var found = null
    for (var i = 0; i < all.length; i++) {
      if (snippetOf(all[i]) !== text) continue
      if (found && !found.contains(all[i])) break
      found = all[i]
    }
    return found
  }

  function find(a) {
    var el = null
    try { el = document.querySelector(a.selector) } catch (e) {}
    if (el && a.snippet && snippetOf(el) !== a.snippet) el = byText(a.snippet) || el
    if (!el && a.snippet) el = byText(a.snippet)
    return el && visible(el) ? el : null
  }

  function report() {
    pending = false
    if (!anchors.length) return
    var pins = []
    for (var i = 0; i < anchors.length; i++) {
      var el = find(anchors[i])
      pins.push({ key: anchors[i].key, rect: el ? box4(el.getBoundingClientRect()) : null })
    }
    send({ type: 'located', path: currentPath(), pins: pins })
  }

  function schedule() {
    if (pending || !anchors.length) return
    pending = true
    ;(window.requestAnimationFrame || setTimeout)(report)
  }

  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  window.addEventListener('load', schedule)
  function isOurs(node) {
    return node.nodeType === 1 && node.hasAttribute('data-artifact-helper')
  }

  // Anything but the helper's own highlight changing may move an element
  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      if (isOurs(r.target)) continue
      if (r.type === 'childList' && Array.prototype.every.call(r.addedNodes, isOurs) && Array.prototype.every.call(r.removedNodes, isOurs)) continue
      return schedule()
    }
  }

  try { new MutationObserver(onMutations).observe(document, { childList: true, subtree: true, attributes: true, characterData: true }) } catch (e) {}

  function show(key) {
    for (var i = 0; i < anchors.length; i++) {
      if (anchors[i].key !== key) continue
      var el = find(anchors[i])
      if (el) try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) {}
    }
  }

  function str(v, max) {
    return typeof v === 'string' && v.length <= max ? v : null
  }

  window.addEventListener('message', function (e) {
    // Only the app that frames the page drives the helper; not the page itself or frames it opens
    if (e.source !== parent) return
    var d = e.data
    if (!d || typeof d !== 'object' || d.artifact !== 1) return
    if (d.type === 'hello') send({ type: 'ready', path: currentPath() })
    else if (d.type === 'pick') startPick()
    else if (d.type === 'stop') stopPick()
    else if (d.type === 'show' && typeof d.key === 'number') show(d.key)
    else if (d.type === 'locate' && Array.isArray(d.anchors)) {
      anchors = []
      for (var i = 0; i < d.anchors.length && i < 200; i++) {
        var a = d.anchors[i]
        var selector = a && str(a.selector, MAX_SELECTOR)
        if (selector && typeof a.key === 'number') anchors.push({ key: a.key, selector: selector, snippet: str(a.snippet, MAX_SNIPPET) || '' })
      }
      report()
    }
  })

  send({ type: 'ready', path: currentPath() })
})()`

const TAG = `<script>${SCRIPT}</script>`

// Part of the ETag of files served with the helper, so browsers fetch them again when it changes
export const HELPER_TAG = createHash('sha256').update(SCRIPT).digest('hex').slice(0, 8)

const BOM = 0xfeff
// Whitespace as HTML parses it: space, tab, line feed, form feed, carriage return
const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d

// Where the doctype ends, past a byte order mark, whitespace and comments before it; else where the
// document starts. A plain scan with indexOf, never a regex, since it runs over untrusted HTML and
// must stay linear whatever the page holds.
export function helperOffset(html: string): number {
  const start = html.charCodeAt(0) === BOM ? 1 : 0
  let i = start
  for (;;) {
    while (i < html.length && isSpace(html.charCodeAt(i))) i++
    if (!html.startsWith('<!--', i)) break
    // "<!-->" and "<!--->" are whole comments too
    const end = html.indexOf('-->', i + 2)
    if (end === -1) return start
    i = end + 3
  }
  if (html.slice(i, i + 9).toLowerCase() !== '<!doctype') return start
  const end = html.indexOf('>', i + 9)
  return end === -1 ? start : end + 1
}

// Right after the doctype, so the page keeps its rendering mode and the helper runs before anything
// the page does, including a <meta> Content-Security-Policy, which only covers what comes after it
export function withFrameHelper(html: string): string {
  const at = helperOffset(html)
  return html.slice(0, at) + TAG + html.slice(at)
}
