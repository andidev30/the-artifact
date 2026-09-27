import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { checkSlug, createOrganization, FieldError, finishPersonalOnboarding, type Me, type Organization, type SlugCheck } from '../api'
import { AccountHeader } from '../components/AccountHeader'
import { ConnectTabs } from '../components/ConnectTabs'
import { InvitationRow } from '../components/InvitationNotice'
import { usePendingInvitations } from '../invitations'
import { APP_HOST } from '../config'
import { useConfig } from '../useConfig'
import { useMe } from '../useMe'
import { LoadError, Loading } from './Status'
import './Workspace.css'

type Choice = 'personal' | 'team'
type Step = 'workspace' | 'organization' | 'agent'

export function Onboarding() {
  const state = useMe()
  const navigate = useNavigate()

  // Onboarding runs once; people who finished it go straight to their pages
  useEffect(() => {
    if (state.kind === 'ready' && state.me.onboarded) navigate('/app', { replace: true })
  }, [state, navigate])

  const config = useConfig()

  if (state.kind === 'loading' || !config) return <Loading />
  if (state.kind === 'error') return <LoadError />
  if (state.me.onboarded) return null
  // Whoever set up a self-hosted server names the organization everyone there works in; no choice to make
  const setUp = config.selfHosted && state.me.isAdmin
  return <Flow me={state.me} selfHosted={config.selfHosted} setUp={setUp} />
}

function Flow({ me, selfHosted, setUp }: { me: Me; selfHosted: boolean; setUp: boolean }) {
  const [params] = useSearchParams()
  const [choice, setChoice] = useState<Choice>(setUp || params.get('plan') === 'organization' ? 'team' : 'personal')
  const [step, setStep] = useState<Step>(setUp ? 'organization' : 'workspace')
  const [workspace, setWorkspace] = useState<string | undefined>()
  const [skipError, setSkipError] = useState<string | null>(null)
  const firstName = me.name?.split(' ')[0]

  // The admin who skips naming an organization starts on their own
  async function skipToPersonal() {
    setSkipError(null)
    try {
      await finishPersonalOnboarding()
      setWorkspace('Personal')
      setChoice('personal')
      setStep('agent')
    } catch {
      setSkipError('Your workspace could not be saved. Try again.')
    }
  }

  const steps: { id: Step; label: string }[] = [
    ...(setUp ? [] : [{ id: 'workspace' as const, label: 'Choose a workspace' }]),
    ...(choice === 'team' ? [{ id: 'organization' as const, label: 'Name your organization' }] : []),
    { id: 'agent', label: 'Connect your agent' },
  ]
  const current = steps.findIndex((s) => s.id === step)

  return (
    <div className="auth">
      <AccountHeader me={me} workspace={workspace} />
      <main id="main" className="onboarding">
        <ol className="onboarding-rail" aria-label="Setup progress">
          {steps.map((s, i) => (
            <li key={s.id} data-state={i < current ? 'done' : i === current ? 'current' : 'todo'} aria-current={i === current ? 'step' : undefined}>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>

        <div className="onboarding-panel">
          {step === 'workspace' && (
            <WorkspaceStep
              me={me}
              selfHosted={selfHosted}
              choice={choice}
              onChoice={setChoice}
              onDone={() => {
                if (choice === 'personal') {
                  setWorkspace('Personal')
                  setStep('agent')
                } else {
                  setStep('organization')
                }
              }}
            />
          )}
          {step === 'organization' && (
            <OrganizationStep
              {...(setUp
                ? {
                    title: `${firstName ? `Welcome, ${firstName}.` : 'Welcome.'} Name your organization`,
                    lede: 'Everyone you add to this server works in it. You become its owner, and can invite people next.',
                    backLabel: 'Skip, just me for now',
                    notice: skipError,
                  }
                : {})}
              onBack={setUp ? skipToPersonal : () => setStep('workspace')}
              onDone={(org) => {
                setWorkspace(org.name)
                setStep('agent')
              }}
            />
          )}
          {step === 'agent' && <AgentStep workspace={workspace ?? 'Personal'} />}
        </div>
      </main>
    </div>
  )
}

function WorkspaceStep({ me, selfHosted, choice, onChoice, onDone }: {
  me: Me
  selfHosted: boolean
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
            <em>{selfHosted ? 'Personal' : 'Personal, free'}</em>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="workspace" value="team" checked={choice === 'team'} onChange={() => onChoice('team')} />
          <span className="choice-body">
            <strong>My team</strong>
            <span>A shared gallery where everyone's agents publish, with pages only your team can open.</span>
            <em>{selfHosted ? 'Organization' : 'Organization, $12 per member / month'}</em>
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

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

// Also used on its own page to create another organization later
export function OrganizationStep({
  onBack,
  onDone,
  title = 'Name your organization',
  lede = 'This is what your teammates see when they join. You become its owner.',
  backLabel = 'Back',
  notice,
}: {
  onBack: () => void
  onDone: (org: Organization) => void
  title?: string
  lede?: string
  backLabel?: string
  notice?: string | null
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [check, setCheck] = useState<(SlugCheck & { slug: string }) | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  const effectiveSlug = slugEdited ? slug : toSlug(name)

  // Check the address shortly after typing stops
  useEffect(() => {
    if (effectiveSlug.length < 3) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      checkSlug(effectiveSlug, controller.signal).then((r) => setCheck({ ...r, slug: effectiveSlug })).catch(() => {})
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [effectiveSlug])

  // Only show a result that belongs to what is in the field right now
  const shownCheck = check?.slug === effectiveSlug ? check : null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const org = await createOrganization(name.trim(), effectiveSlug)
      onDone(org)
    } catch (err) {
      setError(err instanceof FieldError ? { message: err.message, field: err.field } : { message: 'The organization could not be created. Try again.' })
      setSaving(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="onboarding-step">
      <h1>{title}</h1>
      <p className="auth-lede">{lede}</p>

      <div className="field">
        <label htmlFor="org-name">Organization name</label>
        <input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc."
          autoComplete="organization"
          required
          minLength={2}
          maxLength={60}
          autoFocus
          aria-invalid={error?.field === 'name' || undefined}
        />
      </div>

      <div className="field">
        <label htmlFor="org-slug">Address</label>
        <div className="slug-input">
          <span aria-hidden="true">{APP_HOST}/</span>
          <input
            id="org-slug"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugEdited(true)
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
            }}
            placeholder="acme"
            required
            aria-describedby="slug-status"
            aria-invalid={shownCheck?.available === false || error?.field === 'slug' || undefined}
          />
        </div>
        <p id="slug-status" className="field-hint" data-tone={shownCheck ? (shownCheck.available ? 'ok' : 'bad') : undefined} aria-live="polite">
          {shownCheck ? (shownCheck.available ? 'This address is available.' : shownCheck.reason) : 'Lowercase letters, numbers and hyphens.'}
        </p>
      </div>

      {(error || notice) && <p className="auth-notice" role="alert">{error?.message ?? notice}</p>}
      <div className="onboarding-actions">
        <button type="submit" className="button" disabled={saving || shownCheck?.available === false}>
          {saving ? 'Creating organization' : 'Create organization'}
        </button>
        <button type="button" className="auth-reset" onClick={onBack}>{backLabel}</button>
      </div>
    </form>
  )
}

function AgentStep({ workspace }: { workspace: string }) {
  return (
    <div className="onboarding-step">
      <h1>Connect your agent</h1>
      <p className="auth-lede">
        {workspace === 'Personal' ? 'Your workspace is ready.' : `${workspace} is ready.`} Add The Artifact to the
        agent you use. The first time it publishes, it opens a browser window so you can sign in.
      </p>
      <ConnectTabs />
      <div className="onboarding-actions">
        <Link className="button" to="/app">Go to your pages</Link>
        <span className="field-hint">You can find this setup again on your pages.</span>
      </div>
    </div>
  )
}
