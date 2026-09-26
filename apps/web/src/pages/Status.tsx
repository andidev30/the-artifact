import './Auth.css'

export function Loading() {
  return <div className="auth"><p className="app-loading" role="status">Loading your account</p></div>
}

export function LoadError() {
  return (
    <div className="auth">
      <main id="main" className="auth-main">
        <section className="auth-box" role="alert">
          <h1>Your account could not be loaded</h1>
          <p className="auth-lede">The server did not respond. Reload the page to try again.</p>
        </section>
      </main>
    </div>
  )
}
