import { Link } from 'react-router'
import { Wordmark } from '../components/Wordmark'
import './Auth.css'

export function NotFound() {
  return (
    <div className="auth">
      <header className="nav">
        <Wordmark />
      </header>
      <main id="main" className="auth-main">
        <section className="auth-box" aria-labelledby="nf-title">
          <h1 id="nf-title">This page doesn't exist</h1>
          <p className="auth-lede">The link may be mistyped, or the page was moved. If someone sent you a page, ask them to share the link again.</p>
          <Link className="button" to="/">
            Go to the home page
          </Link>
        </section>
      </main>
    </div>
  )
}
