import { useState, type FormEvent } from 'react'
import { finishPersonalOnboarding, type Me } from '../api'
import { InvitationRow } from '../components/InvitationNotice'
import { usePendingInvitations } from '../invitations'

export type Choice = 'personal' | 'team'

// The first onboarding step on the hosted service: a personal workspace or an organization. Self-hosted
// installs skip it; their people start in a personal workspace and join organizations by invitation.
export function WorkspaceChoice({ me, choice, onChoice, onDone }: {
  me: Me
  choice: Choice
  onChoice: (c: Choice) => void
  onDone: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstName = me.name?.split(' ')[0]
  // Joining an organization finishes onboarding, and the page moves on to /app in that workspace
  const { invitations } = usePendingInvitations(me.id)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (choice === 'team') return onDone()
    setSaving(true)
    setError(null)
    try {
      await finishPersonalOnboarding()
      onDone()
    } catch {
      setError('Your workspace could not be saved. Try again.')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="onboarding-step">
      <h1>{firstName ? `Welcome, ${firstName}.` : 'Welcome.'} Who is this workspace for?</h1>
      <p className="auth-lede">
        {invitations.length > 0
          ? 'Join the organization you were invited to, or set up a workspace of your own.'
          : 'You can create an organization later if you start on your own.'}
      </p>

      {invitations.length > 0 && (
        <section className="onboarding-invitations" aria-labelledby="onboarding-invitations-title">
          <h2 id="onboarding-invitations-title">{invitations.length === 1 ? 'You have an invitation' : 'You have invitations'}</h2>
          {invitations.map((inv) => (
            <InvitationRow key={inv.id} me={me} invitation={inv} />
          ))}
          <p className="onboarding-or"><span>or set up your own</span></p>
        </section>
      )}

      <fieldset className="choices">
        <legend className="visually-hidden">Workspace type</legend>
        <label className="choice">
          <input type="radio" name="workspace" value="personal" checked={choice === 'personal'} onChange={() => onChoice('personal')} />
          <span className="choice-body">
            <strong>Just me</strong>
            <span>Pages you publish are yours. Share them by link when you want.</span>
            <em>Personal, free</em>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="workspace" value="team" checked={choice === 'team'} onChange={() => onChoice('team')} />
          <span className="choice-body">
            <strong>My team</strong>
            <span>A shared gallery where everyone's agents publish, with pages only your team can open.</span>
            <em>Organization, $12 per member / month</em>
          </span>
        </label>
      </fieldset>

      {error && <p className="auth-notice" role="alert">{error}</p>}
      <div className="onboarding-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving' : 'Continue'}
        </button>
      </div>
    </form>
  )
}
