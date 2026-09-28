import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  FieldError,
  getSharing,
  removePerson,
  setPersonRole,
  setVisibility,
  sharePeople,
  updateLink,
  type LinkSettings,
  type ShareRole,
  type Sharing,
  type Visibility,
} from '../api'
import { useReturnFocus } from '../focus'
import { useConfig } from '../useConfig'
import { CopyCommand } from './CopyCommand'
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

function attr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The frame the oEmbed endpoint describes, at the full width of wherever it is pasted
function embedCode(embedUrl: string, title: string) {
  return `<iframe src="${attr(embedUrl)}" width="100%" height="600" style="border:0" title="${attr(title)}" loading="lazy" allowfullscreen></iframe>`
}

function Avatar({ name, email, src }: { name: string | null; email: string; src: string | null }) {
  if (src) return <img className="share-avatar" src={src} alt="" referrerPolicy="no-referrer" />
  return (
    <span className="share-avatar" aria-hidden="true">
      {(name ?? email).charAt(0).toUpperCase()}
    </span>
  )
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

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const endOfDay = (date: string) => new Date(`${date}T23:59:59.999`).toISOString()
const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

function linkStatus(link: LinkSettings) {
  const until = !link.expiresAt
    ? 'The link never expires.'
    : link.expired
      ? `The link expired on ${longDate(link.expiresAt)}.`
      : `The link works until ${longDate(link.expiresAt)}.`
  return link.password ? `${until} People who open it enter a password.` : until
}

// Anyone-with-the-link options: when the link stops working, a password, and a reset
function LinkOptions({
  slug,
  link,
  onChange,
  announce,
}: {
  slug: string
  link: LinkSettings
  onChange: (link: LinkSettings) => void
  // The dialog has one status line, so each change is announced once
  announce: (message: string | null) => void
}) {
  const saved = link.expiresAt ? localDate(new Date(link.expiresAt)) : ''
  const [expiry, setExpiry] = useState<'never' | 'date'>(saved ? 'date' : 'never')
  const [date, setDate] = useState(saved)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; field: 'expires' | 'password' | null } | null>(null)
  const [confirmNew, setConfirmNew] = useState(false)
  const newLinkButton = useRef<HTMLButtonElement>(null)
  const expires = expiry === 'date' ? date : ''
  const changed = expiry !== (saved ? 'date' : 'never') || expires !== saved || password !== ''

  async function apply(change: Parameters<typeof updateLink>[1], done: string) {
    setBusy(true)
    setError(null)
    announce(null)
    try {
      const result = await updateLink(slug, change)
      onChange(result.link)
      setPassword('')
      announce(done)
    } catch (err) {
      const field = err instanceof FieldError ? err.field : undefined
      setError({
        message: err instanceof Error ? err.message : 'The link could not be changed. Try again.',
        field: field === 'linkExpiresAt' ? 'expires' : field === 'linkPassword' ? 'password' : null,
      })
    } finally {
      setBusy(false)
    }
  }

  function onSave(e: FormEvent) {
    e.preventDefault()
    if (expiry === 'date' && !date) {
      announce(null)
      setError({ message: 'Choose the last day the link works, or choose Never.', field: 'expires' })
      return
    }
    const change: Parameters<typeof updateLink>[1] = {}
    if (expires !== saved) change.linkExpiresAt = expires ? endOfDay(expires) : null
    if (password) change.linkPassword = password
    apply(change, 'Link settings saved.')
  }

  const describe = (field: 'expires' | 'password', hint: string) => (error?.field === field ? `share-link-error ${hint}` : hint)

  return (
    <div className="share-link">
      <p className="share-link-status">{linkStatus(link)}</p>
      <form className="share-link-form" onSubmit={onSave} noValidate>
        <fieldset className="share-link-field">
          <legend>Link expires</legend>
          <div className="share-expiry">
            <label>
              <input type="radio" name="share-expiry" value="never" checked={expiry === 'never'} onChange={() => setExpiry('never')} />
              Never
            </label>
            <label>
              <input type="radio" name="share-expiry" value="date" checked={expiry === 'date'} onChange={() => setExpiry('date')} />
              On a date
            </label>
            {expiry === 'date' && (
              <>
                <label className="visually-hidden" htmlFor="share-expires">
                  Last day the link works
                </label>
                <input
                  id="share-expires"
                  type="date"
                  value={date}
                  min={localDate(new Date())}
                  onChange={(e) => setDate(e.target.value)}
                  aria-invalid={error?.field === 'expires' || undefined}
                  aria-describedby={describe('expires', 'share-expires-hint')}
                />
              </>
            )}
          </div>
          <p id="share-expires-hint">{expiry === 'date' ? 'It stops working at the end of that day.' : 'It keeps working until you change this.'}</p>
        </fieldset>
        <div className="share-link-field">
          <label htmlFor="share-link-password">{link.password ? 'New link password' : 'Link password'}</label>
          <input
            id="share-link-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error?.field === 'password' || undefined}
            aria-describedby={describe('password', 'share-password-hint')}
          />
          <p id="share-password-hint">{link.password ? 'Type one to replace the current password.' : 'Optional, at least 8 characters.'}</p>
        </div>
        {error && (
          <p id="share-link-error" className="share-message share-error" role="alert">
            {error.message}
          </p>
        )}
        <div className="share-link-actions">
          <button type="submit" className="button button-quiet" disabled={!changed || busy}>
            Save link settings
          </button>
          {link.password && (
            <button type="button" className="button button-quiet" disabled={busy} onClick={() => apply({ linkPassword: null }, 'Password removed.')}>
              Remove password
            </button>
          )}
          <button
            type="button"
            className="button button-quiet share-link-reset"
            ref={newLinkButton}
            aria-expanded={confirmNew}
            aria-controls="share-new-link"
            onClick={() => setConfirmNew((v) => !v)}
          >
            Reset link
          </button>
        </div>
      </form>
      {confirmNew && (
        <div id="share-new-link" className="share-link-confirm" role="group" aria-labelledby="share-new-link-title">
          <p id="share-new-link-title">
            The page gets a new public link, and links shared before stop working. You, the people you added and your organization keep opening it as before.
          </p>
          <div className="share-link-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setConfirmNew(false)
                newLinkButton.current?.focus()
                apply({ rotateLink: true }, 'The link was reset. Copy link to share the new one.')
              }}
            >
              Make a new link
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setConfirmNew(false)
                newLinkButton.current?.focus()
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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
  useReturnFocus()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    getSharing(slug)
      .then(setSharing)
      .catch(() => setLoadError(true))
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
      // Shared by link, people without access of their own need the link's key
      const link = sharing?.visibility === 'link' ? sharing.link.url : `${window.location.origin}/a/${slug}`
      await navigator.clipboard.writeText(link)
      setError(null)
      setNotice('Link copied.')
    } catch {
      setNotice(null)
      setError('The link could not be copied. Copy it from the address bar.')
    }
  }

  const typing = emails.trim().length > 0
  const access = sharing ? generalAccess(sharing.visibility, sharing.organizationName) : null
  const generalOptions: Visibility[] = sharing?.organizationName ? ['private', 'organization', 'link'] : ['private', 'link']

  return (
    <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onClose={onClose} onCancel={onClose}>
      <div className="share-body">
        <h2 id="share-title">Share “{title}”</h2>

        <form className="share-invite" onSubmit={onInvite}>
          <label className="visually-hidden" htmlFor="share-emails">
            Add people by email
          </label>
          <input
            id="share-emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="Add people by email"
            autoComplete="email"
            autoFocus
          />
          <label className="visually-hidden" htmlFor="share-role">
            Role for people you add
          </label>
          <select id="share-role" value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button type="submit" className="button" disabled={!typing || busy}>
            Share
          </button>
        </form>

        {typing && canEmail && (
          <div className="share-notify">
            <label>
              <input type="checkbox" checked={notifyChoice} onChange={(e) => setNotify(e.target.checked)} />
              Notify people by email
            </label>
            {notify && (
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-label="Message for the email"
                placeholder="Message (optional)"
                rows={2}
                maxLength={500}
              />
            )}
          </div>
        )}

        {loadError && (
          <p className="share-message share-error" role="alert">
            Sharing settings could not be loaded. Close and try again.
          </p>
        )}

        {sharing && access && (
          <>
            <h3>People with access</h3>
            <ul className="share-people">
              <li>
                <Avatar name={sharing.owner.name} email={sharing.owner.email} src={sharing.owner.avatarUrl} />
                <span className="share-person">
                  <strong>
                    {sharing.owner.name ?? sharing.owner.email}
                    {sharing.owner.email === currentUserEmail ? ' (you)' : ''}
                  </strong>
                  {sharing.owner.name && <span>{sharing.owner.email}</span>}
                </span>
                <span className="share-owner">Owner</span>
              </li>
              {sharing.people.map((p) => (
                <li key={p.email}>
                  <Avatar name={p.name} email={p.email} src={p.avatarUrl} />
                  <span className="share-person">
                    <strong>
                      {p.name ?? p.email}
                      {p.email === currentUserEmail ? ' (you)' : ''}
                    </strong>
                    <span>{p.pending ? `${p.name ? `${p.email}, ` : ''}invited, no account yet` : p.name ? p.email : ''}</span>
                  </span>
                  <label className="visually-hidden" htmlFor={`role-${p.email}`}>
                    Role for {p.email}
                  </label>
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
                <label className="visually-hidden" htmlFor="share-general">
                  Who can open with the link
                </label>
                <select
                  className="share-quiet"
                  id="share-general"
                  value={sharing.visibility}
                  onChange={(e) => onGeneral(e.target.value as Visibility)}
                  disabled={busy}
                >
                  {generalOptions.map((v) => (
                    <option key={v} value={v}>
                      {generalAccess(v, sharing.organizationName).label}
                    </option>
                  ))}
                </select>
                <p>{access.detail}</p>
              </div>
            </div>
            {sharing.visibility === 'link' && (
              <LinkOptions
                slug={slug}
                link={sharing.link}
                onChange={(link) => setSharing((s) => (s ? { ...s, link } : s))}
                announce={(message) => {
                  setNotice(message)
                  setError(null)
                }}
              />
            )}

            <h3>Embed</h3>
            {sharing.visibility === 'link' && sharing.link.password ? (
              <p className="share-embed-note">Embeds show a sign-in card while the link has a password.</p>
            ) : sharing.visibility === 'link' ? (
              <div className="share-embed">
                <p>Paste the link into Notion or Confluence and choose Embed, or add this code to any site.</p>
                <CopyCommand command={embedCode(sharing.link.embedUrl, title)} label="Copy embed code" plain />
              </div>
            ) : (
              <p className="share-embed-note">Embedding needs Anyone with the link. Until then, an embed shows a sign-in card instead of the page.</p>
            )}
          </>
        )}
      </div>

      {/* Outside the scrolling part, so what an action did shows wherever it was taken */}
      <div className="share-footer">
        {error && (
          <p className="share-message share-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="share-message" role="status">
            {notice}
          </p>
        )}
        <div className="share-footer-actions">
          <button type="button" className="button button-quiet" onClick={copyLink}>
            Copy link
          </button>
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
