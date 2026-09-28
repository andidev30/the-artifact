import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { Me } from '../api'
import { usePendingInvitations } from '../invitations'
import { moveFocusWithArrows } from '../focus'
import { organizationSettingsPath, useWorkspace } from '../workspace'
import { InvitationRow } from './InvitationNotice'
import './WorkspaceSwitcher.css'

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const

// The workspace chip in the header; opens a list of workspaces to switch between
export function WorkspaceSwitcher({ me }: { me: Me }) {
  const { org, name, choose } = useWorkspace(me)
  const { invitations } = usePendingInvitations(me.id)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    function onPointer(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      } else if (root.current?.contains(document.activeElement) && moveFocusWithArrows(root.current.querySelector('.switcher-menu'), e.key)) {
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

  // Move focus into the list when it opens, onto the current workspace
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus()
  }, [open])

  const current = org?.id ?? 'personal'
  const options = [
    ...me.organizations.map((o) => ({
      id: o.id,
      name: o.name,
      note: `Organization, ${ROLE_LABEL[o.role].toLowerCase()}`,
      settings: organizationSettingsPath(o),
    })),
    { id: 'personal', name: 'Personal', note: 'Just you', settings: null },
  ]

  function pick(id: string) {
    choose(id)
    // On an organization's settings, switching shows the settings of the one picked instead
    if (/^\/organizations\/[^/]+\/settings/.test(location.pathname)) {
      const picked = me.organizations.find((o) => o.id === id)
      navigate(picked ? organizationSettingsPath(picked) : '/app')
    }
    setOpen(false)
    button.current?.focus()
  }

  return (
    <div className="switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="workspace-chip switcher-button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Workspace: ${name}. Switch workspace${invitations.length ? `, ${invitations.length} ${invitations.length === 1 ? 'invitation' : 'invitations'}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="switcher-name">{name}</span>
        {invitations.length > 0 && (
          <span className="switcher-badge" aria-hidden="true">
            {invitations.length}
          </span>
        )}
        <svg className="switcher-caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="switcher-menu" id={menuId}>
          <p className="switcher-heading">Switch workspace</p>
          <ul>
            {options.map((o) => (
              <li key={o.id} className="switcher-row">
                <button type="button" aria-current={o.id === current} onClick={() => pick(o.id)}>
                  <span className="switcher-initial" aria-hidden="true">
                    {o.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="switcher-option">
                    <strong>{o.name}</strong>
                    <span>{o.note}</span>
                  </span>
                </button>
                {o.settings && (
                  <Link
                    className="switcher-settings"
                    to={o.settings}
                    onClick={() => setOpen(false)}
                    aria-label={`${o.name} settings`}
                    title={`${o.name} settings`}
                  >
                    <Gear />
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {invitations.length > 0 && (
            <div className="switcher-invitations">
              <p className="switcher-heading">Invitations</p>
              {invitations.map((inv) => (
                <InvitationRow key={inv.id} me={me} invitation={inv} compact onJoined={() => setOpen(false)} />
              ))}
            </div>
          )}
          <div className="switcher-footer">
            <Link to="/organizations/new" onClick={() => setOpen(false)}>
              <span className="switcher-plus" aria-hidden="true">
                +
              </span>
              Create an organization
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function Gear() {
  return (
    <svg className="switcher-gear-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.6 2h2.8l.4 2.3 1.6.9 2.2-.8 1.4 2.4-1.8 1.5v1.4l1.8 1.5-1.4 2.4-2.2-.8-1.6.9-.4 2.3H8.6l-.4-2.3-1.6-.9-2.2.8L3 12.6l1.8-1.5V9.7L3 8.2l1.4-2.4 2.2.8 1.6-.9z" />
      <circle cx="10" cy="10.4" r="2.4" />
    </svg>
  )
}
