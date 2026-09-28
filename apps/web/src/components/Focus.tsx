import { useEffect, useRef, type MouseEvent } from 'react'
import { useLocation } from 'react-router'
import './Focus.css'

// How long a new page may take to render its heading, e.g. while its data loads
const WAIT_MS = 3000
const POLL_MS = 50

function focusTarget(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1
  el.focus()
}

// The first stop on every page: jumps past the header to the page's main content
export function SkipLink() {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    const main = document.getElementById('main')
    if (!main) return
    // Focus instead of following the hash, so the router's location doesn't change
    e.preventDefault()
    focusTarget(main)
  }

  return (
    // biome-ignore lint/a11y/useValidAnchor: a skip link is a link to #main; the click handler only keeps the router's location as it is
    <a className="skip-link" href="#main" onClick={onClick}>
      Skip to content
    </a>
  )
}

// A single-page app never loads a new document, so after moving to another page, screen readers
// would stay on the link that was followed, or lose their place when it disappears. This moves focus
// to the new page's heading instead, which also reads out where you are. Focus that moved on its
// own in the meantime (a field with autoFocus, a dialog, someone already tabbing) is left alone.
export function RouteFocus() {
  const { pathname } = useLocation()
  // The path focus was last handled for; the first load keeps the browser's own start, and strict
  // mode's second run of this effect is not a navigation
  const handled = useRef(pathname)

  useEffect(() => {
    if (handled.current === pathname) return
    handled.current = pathname
    const before = document.activeElement
    if (before?.matches('input, textarea, select') || before?.closest('dialog')) return
    const started = Date.now()
    const timer = setInterval(() => {
      const active = document.activeElement
      const moved = active !== null && active !== before && active !== document.body
      const heading = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1')
      if (moved || heading || Date.now() - started > WAIT_MS) clearInterval(timer)
      if (!moved && heading) focusTarget(heading)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [pathname])

  return null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'

// Many controls swap themselves for others in place: Revoke becomes Revoke and Cancel, Edit becomes a
// form, Set up becomes the setup steps. When the focused control disappears like that, the browser
// drops focus to the top of the document, and keyboard users have to tab all the way back. This puts
// focus on the first control of the nearest part of the page that is still there instead.
export function FocusRescue() {
  useEffect(() => {
    let focused: Element | null = null
    let ancestors: Element[] = []
    function onFocusIn(e: FocusEvent) {
      focused = e.target instanceof Element ? e.target : null
      ancestors = []
      for (let el = focused?.parentElement; el && el !== document.body; el = el.parentElement) ancestors.push(el)
    }
    const observer = new MutationObserver(() => {
      if (!focused || focused.isConnected || (document.activeElement && document.activeElement !== document.body)) return
      const lost = focused
      focused = null
      const scope = ancestors.find((el) => el.isConnected)
      // Whole pages and dialogs coming and going are handled by RouteFocus and useReturnFocus
      if (!scope || scope.matches('#root, main') || lost.closest('dialog')) return
      const target = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !el.closest('[inert], [hidden]'))
      target?.focus()
    })
    document.addEventListener('focusin', onFocusIn)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      observer.disconnect()
    }
  }, [])

  return null
}
