import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getSharing,
  removePerson,
  setPersonRole,
  setVisibility,
  sharePeople,
  type ShareRole,
  type Sharing,
  type Visibility,
} from '../api'
import { useConfig } from '../useConfig'
import './ShareDialog.css'

type Props = {
  slug: string
  title: string
  currentUserEmail: string | null
  onClose: () => void
  onVisibilityChange: (v: Visibility) => void
}

const ROLE_LABEL: Record<ShareRole, string> = { viewer: 'Viewer', editor: 'Editor' }

function generalAccess(v: Visibility, orgName: string | null) {
  if (v === 'private') return { label: 'Restricted', detail: 'Only people with access can open with the link.' }
  if (v === 'organization') return { label: orgName ?? 'Organization', detail: `Anyone in ${orgName ?? 'your organization'} with the link can view.` }
  return { label: 'Anyone with the link', detail: 'Anyone on the internet with the link can view.' }
}

function Avatar({ name, email, src }: { name: string | null; email: string; src: string | null }) {
  if (src) return <img className="share-avatar" src={src} alt="" referrerPolicy="no-referrer" />
  return <span className="share-avatar" aria-hidden="true">{(name ?? email).charAt(0).toUpperCase()}</span>
}

function AccessIcon({ v }: { v: Visibility }) {
  return (
    <span className="share-access-icon" data-visibility={v} aria-hidden="true">
      <svg viewBox="0 0 20 20">
        {v === 'private' && <path d="M6 9V7a4 4 0 1 1 8 0v2M5 9h10v8H5z" />}
        {v === 'organization' && <path d="M3 17V6l7-3 7 3v11M7 17v-4h6v4M7 8h1M12 8h1" />}
        {v === 'link' && <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM2 10h16M10 2c2.5 2.4 2.5 13.6 0 16M10 2c-2.5 2.4-2.5 13.6 0 16" />}
      </svg>
    </span>
  )
}

// Share settings in the shape of Google Drive: add people, people with access, general access
export function ShareDialog({ slug, title, currentUserEmail, onClose, onVisibilityChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [sharing, setSharing] = useState<Sharing | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [emails, setEmails] = useState('')
  const [role, setRole] = useState<ShareRole>('viewer')
  // Servers without email can't notify anyone; the sharer sends the link
  const canEmail = useConfig()?.emailSignIn !== false
  const [notifyChoice, setNotify] = useState(true)
  const notify = canEmail && notifyChoice
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    dialog.current?.showModal()
    getSharing(slug).then(setSharing).catch(() => setLoadError(true))
  }, [slug])

  async function run<T>(action: () => Promise<T>, after: (r: T) => void) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      after(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sharing could not be updated. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function onInvite(e: FormEvent) {
    e.preventDefault()
    run(
      () => sharePeople(slug, emails, role, notify, message),
      (r) => {
        setSharing(r.sharing)
        setEmails('')
        setMessage('')
        const who = r.shared.length === 1 ? r.shared[0] : `${r.shared.length} people`
        setNotice(
          r.notifyFailed.length
            ? `Shared with ${who}. The email to ${r.notifyFailed.join(', ')} could not be sent; send them the link.`
            : `Shared with ${who}.${notify ? ' They will get an email with the link.' : canEmail ? '' : ' Send them the link; this server doesn’t send email.'}`,
        )
      },
    )
  }

  function onRole(email: string, value: string) {
    if (value === 'remove') run(() => removePerson(slug, email), setSharing)
    else run(() => setPersonRole(slug, email, value as ShareRole), setSharing)
  }

  function onGeneral(v: Visibility) {
    run(
      () => setVisibility(slug, v),
      () => {
        setSharing((s) => (s ? { ...s, visibility: v } : s))
        onVisibilityChange(v)
      },
    )
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/a/${slug}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  const typing = emails.trim().length > 0
  const access = sharing ? generalAccess(sharing.visibility, sharing.organizationName) : null
  const generalOptions: Visibility[] = sharing?.organizationName ? ['private', 'organization', 'link'] : ['private', 'link']

  return (
    <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onClose={onClose} onCancel={onClose}>
      <h2 id="share-title">Share “{title}”</h2>

      <form className="share-invite" onSubmit={onInvite}>
        <label className="visually-hidden" htmlFor="share-emails">Add people by email</label>
        <input
          id="share-emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="Add people by email"
          autoComplete="email"
          autoFocus
        />
        <label className="visually-hidden" htmlFor="share-role">Role for people you add</label>
        <select id="share-role" value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button type="submit" className="button" disabled={!typing || busy}>Share</button>
      </form>

      {typing && canEmail && (
        <div className="share-notify">
          <label>
            <input type="checkbox" checked={notifyChoice} onChange={(e) => setNotify(e.target.checked)} />
            Notify people by email
          </label>
          {notify && (
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message (optional)" rows={2} maxLength={500} />
          )}
        </div>
      )}

      {error && <p className="share-message share-error" role="alert">{error}</p>}
      {notice && <p className="share-message" role="status">{notice}</p>}

      {loadError && <p className="share-message share-error" role="alert">Sharing settings could not be loaded. Close and try again.</p>}

      {sharing && access && (
        <>
          <h3>People with access</h3>
          <ul className="share-people">
            <li>
              <Avatar name={sharing.owner.name} email={sharing.owner.email} src={sharing.owner.avatarUrl} />
              <span className="share-person">
                <strong>{sharing.owner.name ?? sharing.owner.email}{sharing.owner.email === currentUserEmail ? ' (you)' : ''}</strong>
                {sharing.owner.name && <span>{sharing.owner.email}</span>}
              </span>
              <span className="share-owner">Owner</span>
            </li>
            {sharing.people.map((p) => (
              <li key={p.email}>
                <Avatar name={p.name} email={p.email} src={p.avatarUrl} />
                <span className="share-person">
                  <strong>{p.name ?? p.email}{p.email === currentUserEmail ? ' (you)' : ''}</strong>
                  <span>{p.pending ? `${p.name ? `${p.email}, ` : ''}invited, no account yet` : p.name ? p.email : ''}</span>
                </span>
                <label className="visually-hidden" htmlFor={`role-${p.email}`}>Role for {p.email}</label>
                <select className="share-quiet" id={`role-${p.email}`} value={p.role} onChange={(e) => onRole(p.email, e.target.value)} disabled={busy}>
                  <option value="viewer">{ROLE_LABEL.viewer}</option>
                  <option value="editor">{ROLE_LABEL.editor}</option>
                  <option value="remove">Remove access</option>
                </select>
              </li>
            ))}
          </ul>

          <h3>General access</h3>
          <div className="share-general">
            <AccessIcon v={sharing.visibility} />
            <div>
              <label className="visually-hidden" htmlFor="share-general">Who can open with the link</label>
              <select className="share-quiet" id="share-general" value={sharing.visibility} onChange={(e) => onGeneral(e.target.value as Visibility)} disabled={busy}>
                {generalOptions.map((v) => (
                  <option key={v} value={v}>{generalAccess(v, sharing.organizationName).label}</option>
                ))}
              </select>
              <p>{access.detail}</p>
            </div>
          </div>
        </>
      )}

      <div className="share-footer">
        <button type="button" className="button button-quiet" onClick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</button>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>Done</button>
      </div>
    </dialog>
  )
}
