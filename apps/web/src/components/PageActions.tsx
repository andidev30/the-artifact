import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { deleteArtifact, renameArtifact } from '../api'
import { useReturnFocus } from '../focus'
import './PageActions.css'

const MAX_TITLE = 200

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean } | { label: string; to: string } | { label: string; download: string }

// A small "more" menu in the WAI-ARIA menu button pattern: Enter, Space or the arrow keys open it,
// arrow keys, Home and End move between items, Escape closes it and puts focus back on the button
export function PageMenu({ label, items, className }: { label: string; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  // Arrow Up on the closed button opens the menu on its last item
  const startAtEnd = useRef(false)

  useEffect(() => {
    if (!open) return
    const all = root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    all?.[startAtEnd.current ? all.length - 1 : 0]?.focus()
    startAtEnd.current = false
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function close() {
    setOpen(false)
    button.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (e.target === button.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        startAtEnd.current = e.key === 'ArrowUp'
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
    all[next]?.focus()
  }

  if (items.length === 0) return null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the menu's items, which are buttons
    <div className={`page-menu ${className ?? ''}`} ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="page-menu-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="page-menu-list" role="menu" id={id} aria-label={label}>
          {items.map((item) =>
            'to' in item ? (
              <Link key={item.label} role="menuitem" to={item.to} tabIndex={-1}>
                {item.label}
              </Link>
            ) : 'download' in item ? (
              <a key={item.label} role="menuitem" href={item.download} download tabIndex={-1} onClick={() => close()}>
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-danger={item.danger || undefined}
                onClick={() => {
                  // Back on the menu button first, so a dialog this opens returns focus there
                  close()
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export function PageDialog({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useReturnFocus()
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog ref={dialog} className="page-dialog" aria-labelledby={labelledBy} onClose={onClose} onCancel={onClose}>
      {children}
    </dialog>
  )
}

export function RenameDialog({ slug, title, onClose, onRenamed }: { slug: string; title: string; onClose: () => void; onRenamed: (title: string) => void }) {
  const [value, setValue] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = value.trim()
  const tooLong = trimmed.length > MAX_TITLE

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!trimmed || tooLong) return
    if (trimmed === title) return onClose()
    setBusy(true)
    setError(null)
    try {
      const r = await renameArtifact(slug, trimmed)
      onRenamed(r.title)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The page could not be renamed. Try again.')
      setBusy(false)
    }
  }

  return (
    <PageDialog labelledBy="rename-title" onClose={onClose}>
      <form onSubmit={onSubmit}>
        <h2 id="rename-title">Rename page</h2>
        <label className="page-dialog-label" htmlFor="rename-input">
          Name
        </label>
        <input
          id="rename-input"
          className="page-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          autoFocus
          aria-invalid={tooLong || undefined}
          aria-describedby="rename-hint"
        />
        <p id="rename-hint" className="page-dialog-hint" data-over={tooLong || undefined}>
          {tooLong ? `${trimmed.length - MAX_TITLE} characters over the ${MAX_TITLE} limit.` : 'The link stays the same.'}
        </p>
        {error && (
          <p className="page-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !trimmed || tooLong}>
            {busy ? 'Saving' : 'Save'}
          </button>
        </div>
      </form>
    </PageDialog>
  )
}

export function DeleteDialog({ slug, title, onClose, onDeleted }: { slug: string; title: string; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onDelete() {
    setBusy(true)
    setError(null)
    try {
      await deleteArtifact(slug)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The page could not be deleted. Try again.')
      setBusy(false)
    }
  }

  return (
    <PageDialog labelledBy="delete-title" onClose={onClose}>
      <h2 id="delete-title">Delete “{title}”?</h2>
      <p className="page-dialog-text">
        The link stops working for everyone, including people you shared it with, and every version is deleted. This can't be undone.
      </p>
      {error && (
        <p className="page-dialog-error" role="alert">
          {error}
        </p>
      )}
      <div className="page-dialog-actions">
        <button type="button" className="button button-quiet" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="button page-dialog-danger" onClick={onDelete} disabled={busy}>
          {busy ? 'Deleting' : 'Delete page'}
        </button>
      </div>
    </PageDialog>
  )
}
