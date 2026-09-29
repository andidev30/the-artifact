import { useEffect, useState } from 'react'
import { dismissAutoJoinNotice, type AutoJoined, type Me } from '../api'
import { refreshMe } from '../useMe'
import { chooseWorkspace, storedWorkspace, useWorkspace } from '../workspace'
import './InvitationNotice.css'

// Organizations the server added this person to because of their email domain, shown until dismissed
export function AutoJoinNotice({ me }: { me: Me }) {
  const { org, choose } = useWorkspace(me)
  const [hidden, setHidden] = useState<string[]>([])
  const shown = me.autoJoined.filter((n) => !hidden.includes(n.organizationId) && me.organizations.some((o) => o.id === n.organizationId))
  const first = shown[0]?.organizationId

  // Someone who never chose a workspace starts in the organization they were added to
  useEffect(() => {
    if (first && storedWorkspace() === null) chooseWorkspace(first)
  }, [first])

  if (!shown.length) return null

  function dismiss(notice: AutoJoined) {
    setHidden((h) => [...h, notice.organizationId])
    dismissAutoJoinNotice(notice.organizationId)
      .then(refreshMe)
      // It shows again on the next visit, which is all a failure here costs
      .catch(() => {})
  }

  return (
    <section className="invitation-notice" aria-label="Organizations you joined">
      {shown.map((n) => (
        <div key={n.organizationId} className="invitation-row">
          <span className="invitation-initial" aria-hidden="true">
            {n.name.slice(0, 1).toUpperCase()}
          </span>
          <p className="invitation-text">
            You joined <strong>{n.name}</strong> because your address is on <strong>{n.domain}</strong>.
          </p>
          <div className="invitation-actions">
            {org?.id !== n.organizationId && (
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  choose(n.organizationId)
                  dismiss(n)
                }}
              >
                Open {n.name}
              </button>
            )}
            <button type="button" className="auth-reset" onClick={() => dismiss(n)} aria-label={`Dismiss the notice about ${n.name}`}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}
