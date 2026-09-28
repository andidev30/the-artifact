import { useState, type FormEvent } from 'react'
import { finishPersonalOnboarding, type Me } from '../api'
import { InvitationRow } from '../components/InvitationNotice'
import { usePendingInvitations } from '../invitations'

// The first onboarding step on the hosted service. Everyone starts in a personal workspace, since new
// organizations wait for billing (apps/api/src/ee/plans.ts), but pending invitations show here so a new
// account can join its team. Self-hosted installs skip this step.
export function Welcome({ me, onDone }: { me: Me; onDone: () => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstName = me.name?.split(' ')[0]
  // Joining an organization finishes onboarding, and the page moves on to /app in that workspace
  const { invitations } = usePendingInvitations(me.id)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
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
      <h1>{firstName ? `Welcome, ${firstName}.` : 'Welcome.'}</h1>
      <p className="auth-lede">
        {invitations.length > 0
          ? 'Join the organization you were invited to, or start in your personal workspace.'
          : 'You start in your personal workspace. Pages you publish there are yours, and you can share them by link when you want.'}
      </p>

      {invitations.length > 0 && (
        <section className="onboarding-invitations" aria-labelledby="onboarding-invitations-title">
          <h2 id="onboarding-invitations-title">{invitations.length === 1 ? 'You have an invitation' : 'You have invitations'}</h2>
          {invitations.map((inv) => (
            <InvitationRow key={inv.id} me={me} invitation={inv} />
          ))}
          <p className="onboarding-or">
            <span>or start on your own</span>
          </p>
        </section>
      )}

      <p className="field-hint">Organizations for teams are coming soon. You can still join one you are invited to.</p>

      {error && (
        <p className="auth-notice" role="alert">
          {error}
        </p>
      )}
      <div className="onboarding-actions">
        <button type="submit" className="button" disabled={saving}>
          {saving ? 'Saving' : 'Continue'}
        </button>
      </div>
    </form>
  )
}
