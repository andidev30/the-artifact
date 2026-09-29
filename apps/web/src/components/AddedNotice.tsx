import { Fragment, useEffect, useRef, useState } from 'react'
import { dismissAddedNotice, listAddedNotices, removeMember, type AddedNotice as Notice, type Me } from '../api'
import { useConfirmFocus } from '../focus'
import { refreshMe } from '../useMe'
import { chooseWorkspace, storedWorkspace } from '../workspace'
import './InvitationNotice.css'

// Organizations an owner or admin added you to directly (self-hosted servers), shown once on your pages
// so being added never goes unnoticed, with a way out
export function AddedNotice({ me }: { me: Me }) {
  const [notices, setNotices] = useState<Notice[]>([])

  // biome-ignore lint/correctness/useExhaustiveDependencies: another account signed in has notices of its own
  useEffect(() => {
    let active = true
    listAddedNotices()
      .then((rows) => active && setNotices(rows))
      // Only a notice; the organization is in the workspace switcher either way
      .catch(() => {})
    return () => {
      active = false
    }
  }, [me.id])

  // The focused button goes with the notice it was in; the page's heading takes focus instead of the document
  const dropped = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the list without that notice is on screen
  useEffect(() => {
    if (!dropped.current) return
    dropped.current = false
    if (document.activeElement && document.activeElement !== document.body) return
    const heading = document.querySelector<HTMLElement>('main h1')
    if (!heading) return
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus()
  }, [notices])

  if (notices.length === 0) return null
  function drop(id: string) {
    dropped.current = true
    setNotices((list) => list.filter((n) => n.organization.id !== id))
  }
  return (
    <section className="invitation-notice" aria-label="Organizations you were added to">
      {notices.map((n) => (
        <AddedRow key={n.organization.id} me={me} notice={n} onDone={() => drop(n.organization.id)} />
      ))}
    </section>
  )
}

function AddedRow({ me, notice, onDone }: { me: Me; notice: Notice; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const scope = useConfirmFocus<HTMLDivElement>(confirming ? 'leave' : null)
  const org = notice.organization

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true)
    setProblem(null)
    try {
      await action()
      onDone()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : fallback)
      setBusy(false)
    }
  }

  const open = () =>
    run(async () => {
      // Seen either way: failing to record it only means the notice shows once more
      await dismissAddedNotice(org.id).catch(() => {})
      chooseWorkspace(org.id)
    }, 'That did not work. Try again.')

  const leave = () =>
    run(async () => {
      await removeMember(org.id, me.id)
      if (storedWorkspace() === org.id) chooseWorkspace('personal')
      refreshMe()
    }, `You could not leave ${org.name}. Try again.`)

  return (
    <div ref={scope} className="invitation-row">
      <span className="invitation-initial" aria-hidden="true">
        {org.name.slice(0, 1).toUpperCase()}
      </span>
      <p className="invitation-text">
        {confirming ? (
          <>
            Leave <strong>{org.name}</strong>? You can open its pages again only if someone adds or invites you back.
          </>
        ) : (
          <>
            <strong>{notice.addedBy ?? 'Someone'}</strong> added you to <strong>{org.name}</strong>.
          </>
        )}
      </p>
      <div className="invitation-actions">
        {/* Keyed so the two sets of buttons never share elements: reusing the Open button as the
            confirmation's Leave would skip its autoFocus and leave focus on what became Cancel */}
        {confirming ? (
          <Fragment key="confirm">
            <button type="button" className="button button-small button-danger" onClick={leave} disabled={busy} autoFocus>
              {busy ? 'Leaving' : `Leave ${org.name}`}
            </button>
            <button type="button" className="auth-reset" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </Fragment>
        ) : (
          <Fragment key="actions">
            <button type="button" className="button button-small" onClick={open} disabled={busy}>
              Open {org.name}
            </button>
            <button
              type="button"
              className="auth-reset"
              data-confirms="leave"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={`Leave ${org.name}`}
            >
              Leave
            </button>
            <button
              type="button"
              className="auth-reset"
              onClick={() => run(() => dismissAddedNotice(org.id), 'The notice could not be dismissed. Try again.')}
              disabled={busy}
              aria-label={`Dismiss the notice about ${org.name}`}
            >
              Dismiss
            </button>
          </Fragment>
        )}
      </div>
      {problem && (
        <p className="invitation-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
