import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { logout, type Me } from '../api'
import { organizationSettingsPath, useWorkspace } from '../workspace'
import { moveFocusWithArrows } from '../focus'
import './AccountMenu.css'

// The person's name in the header; opens their account settings, the current organization's
// settings, Server admin for instance admins, and Log out.
export function AccountMenu({ me }: { me: Me }) {
  const navigate = useNavigate()
  const { org } = useWorkspace(me)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const display = me.name ?? me.email

  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      } else if (root.current?.contains(document.activeElement) && moveFocusWithArrows(root.current.querySelector('.account-menu'), e.key)) {
        e.preventDefault()
      }
    }
    // Tabbing out of the list closes it, like clicking elsewhere
    function onFocusOut(e: FocusEvent) {
      if (e.relatedTarget instanceof Node && !root.current?.contains(e.relatedTarget)) setOpen(false)
    }
    const el = root.current
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    el?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      el?.removeEventListener('focusout', onFocusOut)
    }
  }, [open])

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('.account-menu a, .account-menu button')?.focus()
  }, [open])

  async function onLogout() {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <div className="account" ref={root}>
      <button
        ref={button}
        type="button"
        className="account-button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account: ${display}`}
        onClick={() => setOpen((v) => !v)}
      >
        {me.avatarUrl ? (
          <img className="account-avatar" src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="account-avatar" aria-hidden="true">
            {display.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="account-name">{display}</span>
        <svg className="account-caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="account-menu" id={menuId}>
          <p className="account-who">
            <strong>{display}</strong>
            {me.name && <span>{me.email}</span>}
          </p>
          <ul>
            {me.onboarded && (
              <li>
                <Link to="/settings" onClick={() => setOpen(false)}>
                  Account settings
                </Link>
              </li>
            )}
            {me.onboarded && org && (
              <li>
                <Link to={organizationSettingsPath(org)} onClick={() => setOpen(false)}>
                  {org.name} settings
                </Link>
              </li>
            )}
            {me.isAdmin && (
              <li className="account-admin">
                <Link to="/admin" onClick={() => setOpen(false)}>
                  Server admin
                </Link>
              </li>
            )}
            <li className="account-logout">
              <button type="button" onClick={onLogout}>
                Log out
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
