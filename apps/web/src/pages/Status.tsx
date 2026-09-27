import { useEffect } from 'react'
import './Auth.css'

export function Loading() {
  return <div className="auth"><p className="app-loading" role="status">Loading your account</p></div>
}

export function LoadError() {
  return <ServerUnreachable title="Your account could not be loaded" />
}

// The API isn't answering, e.g. while it restarts. Checks again every few seconds and reloads once it does.
export function ServerUnreachable({ title = 'Can’t reach the server' }: { title?: string }) {
  useEffect(() => {
    const timer = setInterval(() => {
      fetch('/api/config')
        .then((res) => res.ok && window.location.reload())
        .catch(() => {})
    }, 4000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="auth">
      <main id="main" className="auth-main">
        <section className="auth-box" role="alert">
          <h1>{title}</h1>
          <p className="auth-lede">
            The Artifact isn’t answering right now. It may be starting up. This page tries again every few seconds and
            opens once it answers.
          </p>
          <button type="button" className="button" onClick={() => window.location.reload()}>Try again now</button>
        </section>
      </main>
    </div>
  )
}
