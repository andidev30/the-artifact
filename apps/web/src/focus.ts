import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// For dialogs: remembers what had focus when the dialog opened and gives focus back to it when the
// dialog goes away. A layout effect, so it runs before the dialog's showModal() moves focus inside.
// When that control is gone too (the card of a page just deleted), the page's heading gets focus, so
// keyboard and screen reader users don't end up at the top of the document.
export function useReturnFocus() {
  // A ref, so the second run of this effect in React's strict mode (by then focus is inside the
  // dialog) keeps the control that opened it
  const openerRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!openerRef.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      openerRef.current = document.activeElement
    }
    const opener = openerRef.current
    return () => {
      // After the dialog's own nodes are gone, which is when React runs this
      requestAnimationFrame(() => {
        if (opener?.isConnected) return opener.focus()
        const active = document.activeElement
        if (active && active !== document.body && active.isConnected) return
        const heading = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1')
        if (!heading) return
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
        heading.focus()
      })
    }
  }, [])
}

// For a control that swaps in place for a confirmation (Delete, then Delete and Cancel): the
// confirmation takes focus with autoFocus, but closing it removes the focused button, so focus would
// fall back to the document. Returns a ref for an element around both; when `open` (which confirmation
// is showing) goes back to null with focus lost, the control marked data-confirms="<that kind>" gets it.
export function useConfirmFocus<T extends HTMLElement>(open: string | null) {
  const scope = useRef<T>(null)
  const last = useRef(open)
  useEffect(() => {
    const was = last.current
    last.current = open
    if (was === null || open !== null) return
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    scope.current?.querySelector<HTMLElement>(`[data-confirms="${was}"]`)?.focus()
  }, [open])
  return scope
}

const FOCUSABLE = 'a[href], button:not([disabled])'

// Arrow keys, Home and End move between the links and buttons of an open popup (the account menu,
// the workspace switcher). Returns whether the key was one of those.
export function moveFocusWithArrows(container: HTMLElement | null, key: string) {
  if (!container || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return false
  const all = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (all.length === 0) return false
  const at = all.indexOf(document.activeElement as HTMLElement)
  const step = key === 'ArrowDown' ? 1 : -1
  const next = key === 'Home' ? 0 : key === 'End' ? all.length - 1 : at === -1 ? (step === 1 ? 0 : all.length - 1) : (at + step + all.length) % all.length
  all[next]?.focus()
  return true
}

// A box that scrolls sideways (a long command) has to be reachable with Tab, or keyboard users can't
// scroll it. Gives the element a tab stop only while its content overflows.
export function useScrollFocus<T extends HTMLElement>(content: string) {
  const ref = useRef<T>(null)
  const [scrolls, setScrolls] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: new content can start or stop overflowing
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const check = () => setScrolls(el.scrollWidth > el.clientWidth)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [content])
  return { ref, tabIndex: scrolls ? 0 : undefined }
}
