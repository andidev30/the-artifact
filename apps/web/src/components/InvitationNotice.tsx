import { useState } from 'react'
import type { Me, MyInvitation } from '../api'
import { INVITE_ROLE_TEXT, usePendingInvitations } from '../invitations'
import './InvitationNotice.css'

// Invitations to your email, shown on your pages so you can join without finding the email
export function InvitationNotice({ me }: { me: Me }) {
  const { invitations } = usePendingInvitations(me.id)
  if (invitations.length === 0) return null
  return (
    <section className="invitation-notice" aria-label="Invitations">
      {invitations.map((inv) => (
        <InvitationRow key={inv.id} me={me} invitation={inv} />
      ))}
    </section>
  )
}

export function InvitationRow({
  me,
  invitation,
  compact = false,
  onJoined,
}: {
  me: Me
  invitation: MyInvitation
  compact?: boolean
  onJoined?: (org: { id: string; name: string }) => void
}) {
  const { accept, decline } = usePendingInvitations(me.id)
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const org = invitation.organization.name

  async function run(kind: 'join' | 'decline') {
    setBusy(kind)
    setProblem(null)
    try {
      if (kind === 'join') {
        const org = await accept(invitation)
        onJoined?.(org)
      } else {
        await decline(invitation)
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That did not work. Try again.')
      setBusy(null)
    }
  }

  return (
    <div className="invitation-row" data-compact={compact || undefined}>
      <span className="invitation-initial" aria-hidden="true">
        {org.slice(0, 1).toUpperCase()}
      </span>
      <p className="invitation-text">
        <strong>{invitation.invitedBy ?? 'Someone'}</strong> invited you to join <strong>{org}</strong> as {INVITE_ROLE_TEXT[invitation.role]}.
      </p>
      <div className="invitation-actions">
        <button type="button" className="button button-small" onClick={() => run('join')} disabled={busy !== null} aria-label={`Join ${org}`}>
          {busy === 'join' ? 'Joining' : 'Join'}
        </button>
        <button type="button" className="auth-reset" onClick={() => run('decline')} disabled={busy !== null} aria-label={`Decline the invitation to ${org}`}>
          {busy === 'decline' ? 'Declining' : 'Decline'}
        </button>
      </div>
      {problem && (
        <p className="invitation-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
