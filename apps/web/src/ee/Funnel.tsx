import { useEffect, useState } from 'react'
import { adminRequest } from '../adminApi'
import './Funnel.css'

// Server admin on the hosted service: the sign-up funnel from src/ee/analytics.ts in the API

type Step = 'signed_up' | 'onboarded' | 'agent_connected' | 'page_published' | 'page_shared'
type Method = 'email_link' | 'password' | 'google' | 'sso'

type FunnelData = {
  windows: number[]
  steps: { event: Step; counts: number[] }[]
  signUpMethods: { method: Method; counts: number[] }[]
  publishes: number[]
  retentionMonths: number
}

const STEP_LABEL: Record<Step, string> = {
  signed_up: 'Signed up',
  onboarded: 'Finished setup',
  agent_connected: 'Connected an agent',
  page_published: 'Published a page',
  page_shared: 'Shared a page',
}

const METHOD_LABEL: Record<Method, string> = {
  email_link: 'Email link',
  password: 'Password',
  google: 'Google',
  sso: 'Single sign-on',
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '–')

export function FunnelSection() {
  const [data, setData] = useState<{ kind: 'loading' } | { kind: 'ready'; data: FunnelData } | { kind: 'error' }>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    adminRequest<FunnelData>('/analytics/funnel')
      .then((d) => active && setData({ kind: 'ready', data: d }))
      .catch(() => active && setData({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  return (
    <section id="funnel" className="settings-card" aria-labelledby="funnel-title">
      <header className="settings-card-head">
        <h2 id="funnel-title">Sign-up funnel</h2>
        <p>
          Accounts created in each period, and how many of them went on to each step. Each percentage is of the step above. Events hold no page content, titles
          or email addresses.
        </p>
      </header>

      {data.kind === 'loading' && (
        <p className="settings-muted" role="status">
          Loading the funnel
        </p>
      )}
      {data.kind === 'error' && (
        <p className="auth-notice" role="alert">
          The funnel could not be loaded. Reload to try again.
        </p>
      )}

      {data.kind === 'ready' && (
        <>
          <table className="funnel-table">
            <caption className="settings-label">Steps</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                {data.data.windows.map((days) => (
                  <th key={days} scope="col">
                    {days} days
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.steps.map((step, i) => {
                const first = data.data.steps[0].counts
                const previous = i > 0 ? data.data.steps[i - 1].counts : null
                return (
                  <tr key={step.event}>
                    <th scope="row">{STEP_LABEL[step.event]}</th>
                    {step.counts.map((n, w) => (
                      <td key={data.data.windows[w]}>
                        <span className="funnel-count">{n.toLocaleString('en')}</span>
                        {previous && <span className="funnel-rate">{percent(n, previous[w])}</span>}
                        <span className="funnel-bar" aria-hidden="true">
                          <span style={{ width: first[w] ? `${Math.min(100, (n / first[w]) * 100)}%` : '0%' }} />
                        </span>
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>

          <table className="funnel-table">
            <caption className="settings-label">Sign-up method</caption>
            <thead>
              <tr>
                <th scope="col">Method</th>
                {data.data.windows.map((days) => (
                  <th key={days} scope="col">
                    {days} days
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.signUpMethods.map((m) => (
                <tr key={m.method}>
                  <th scope="row">{METHOD_LABEL[m.method]}</th>
                  {m.counts.map((n, w) => (
                    <td key={data.data.windows[w]}>
                      <span className="funnel-count">{n.toLocaleString('en')}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <table className="funnel-table">
            <caption className="settings-label">Activity</caption>
            <thead>
              <tr>
                <th scope="col">Everyone</th>
                {data.data.windows.map((days) => (
                  <th key={days} scope="col">
                    {days} days
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Publishes</th>
                {data.data.publishes.map((n, w) => (
                  <td key={data.data.windows[w]}>
                    <span className="funnel-count">{n.toLocaleString('en')}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          <p className="field-hint">Events are kept for {data.data.retentionMonths} months and deleted with the account.</p>
        </>
      )}
    </section>
  )
}
