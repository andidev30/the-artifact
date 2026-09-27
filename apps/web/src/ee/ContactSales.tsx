import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Wordmark } from '../components/Wordmark'
import { CONTACT_SALES_API_URL } from '../config'
import '../pages/Auth.css'
import './ContactSales.css'

type Field = 'name' | 'email' | 'company' | 'teamSize' | 'message'
type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string; field?: Field }

// Keep in sync with TEAM_SIZES in apps/api/src/ee/contact.ts
const TEAM_SIZES = [
  { value: '1-10', label: '1 to 10 people' },
  { value: '11-50', label: '11 to 50 people' },
  { value: '51-200', label: '51 to 200 people' },
  { value: '201-1000', label: '201 to 1,000 people' },
  { value: '1000+', label: 'More than 1,000 people' },
]

const TOPICS = ['enterprise', 'self-hosted-enterprise']

export function ContactSales() {
  const [params] = useSearchParams()
  const topic = TOPICS.includes(params.get('topic') ?? '') ? params.get('topic')! : 'enterprise'
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    document.title = 'Contact sales | The Artifact'
    return () => {
      document.title = 'The Artifact'
    }
  }, [])

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.currentTarget))
    const email = String(data.email ?? '').trim()
    setStatus({ kind: 'sending' })
    try {
      const res = await fetch(CONTACT_SALES_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, topic }),
      })
      if (res.status === 400 || res.status === 429) {
        const body = await res.json().catch(() => ({}))
        if (body.error) return setStatus({ kind: 'error', message: body.error, field: body.field })
      }
      if (!res.ok) throw new Error(String(res.status))
      setStatus({ kind: 'sent', email })
    } catch {
      setStatus({ kind: 'error', message: 'Your message could not be sent. Check your connection and try again.' })
    }
  }

  const error = status.kind === 'error' ? status : null
  // Props that tie a field to the error the server named
  const invalid = (field: Field) => (error?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': 'contact-error' } : {})

  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
        <p className="auth-switch">
          <Link to="/#pricing">Back to pricing</Link>
        </p>
      </header>

      <main id="main" className="contact">
        <section className="contact-pitch" aria-labelledby="contact-title">
          <p className="contact-eyebrow">{topic === 'self-hosted-enterprise' ? 'Self-hosted Enterprise' : 'Enterprise'}</p>
          <h1 id="contact-title">Bring The Artifact to your whole company.</h1>
          <p className="contact-lede">
            The self-hosted version is free and has every feature. When your company needs more than that, tell us what you are working with and we will reply
            by email.
          </p>
          <h2>Talk to us about</h2>
          <ul>
            <li>
              <strong>Running it yourself, with support.</strong> Help when something breaks, and an agreed response time.
            </li>
            <li>
              <strong>Single sign-on.</strong> SSO with SAML through your identity provider.
            </li>
            <li>
              <strong>Custom terms.</strong> Contracts, invoices, an SLA, and your security review.
            </li>
            <li>
              <strong>Rolling it out.</strong> Getting your teams and their agents set up.
            </li>
          </ul>
        </section>

        {status.kind === 'sent' ? (
          <section className="auth-box contact-box auth-sent" role="status" aria-labelledby="contact-sent-title">
            <h2 id="contact-sent-title">Thanks, we got your message</h2>
            <p>
              We will reply to <strong>{status.email}</strong> by email.
            </p>
            <Link className="auth-reset" to="/">
              Back to the home page
            </Link>
          </section>
        ) : (
          <section className="auth-box contact-box" aria-labelledby="contact-form-title">
            <h2 id="contact-form-title">Contact sales</h2>
            <form className="auth-form contact-form" onSubmit={onSubmit}>
              <label htmlFor="contact-name">Name</label>
              <input id="contact-name" name="name" autoComplete="name" required maxLength={100} {...invalid('name')} />

              <label htmlFor="contact-email">Work email</label>
              <input
                id="contact-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                maxLength={254}
                {...invalid('email')}
              />

              <label htmlFor="contact-company">Company</label>
              <input id="contact-company" name="company" autoComplete="organization" required maxLength={120} {...invalid('company')} />

              <label htmlFor="contact-team">Team size</label>
              <select id="contact-team" name="teamSize" required defaultValue="" {...invalid('teamSize')}>
                <option value="" disabled>
                  Choose one
                </option>
                {TEAM_SIZES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>

              <label htmlFor="contact-message">What would you like to talk about?</label>
              <textarea
                id="contact-message"
                name="message"
                rows={5}
                required
                minLength={10}
                maxLength={5000}
                placeholder="How many people would use it, where you would run it, what your security review needs."
                {...invalid('message')}
              />

              {/* Left empty by people; bots that fill every field are dropped by the server */}
              <div className="contact-trap" aria-hidden="true">
                <label htmlFor="contact-website">Website</label>
                <input id="contact-website" name="website" tabIndex={-1} autoComplete="off" />
              </div>

              {error && (
                <p id="contact-error" className="auth-error" role="alert">
                  {error.message}
                </p>
              )}
              <button type="submit" className="button" disabled={status.kind === 'sending'}>
                {status.kind === 'sending' ? 'Sending' : 'Send message'}
              </button>
            </form>
          </section>
        )}
      </main>
    </div>
  )
}
