import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { fetchMe, type Me } from '../api'
import { ConnectTabs } from '../components/ConnectTabs'
import { Wordmark } from '../components/Wordmark'
import { APP_HOST, DOCS_URL, LOGIN_URL, SELF_HOSTING_URL, SIGNUP_URL } from '../config'
import { FlowDemo } from './FlowDemo'
import { Pricing } from './Pricing'
import './Landing.css'

// undefined while checking, null when signed out
type Session = Me | null | undefined

// The hosted service's home page. Self-hosted installs never load it (see pages/Home.tsx).
export function Landing() {
  const [me, setMe] = useState<Session>(undefined)

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  const signedIn = Boolean(me)
  const firstName = me?.name?.split(' ')[0]

  return (
    <>
      <header className="nav">
        <Wordmark />
        <nav aria-label="Primary">
          <a className="nav-section" href="#how">
            How it works
          </a>
          <a className="nav-section" href="#pricing">
            Pricing
          </a>
          <Link className="nav-section" to={DOCS_URL}>
            Docs
          </Link>
          {me === undefined ? (
            <span className="nav-pending" aria-hidden="true" />
          ) : me ? (
            <>
              <span className="nav-account">
                {me.avatarUrl && <img src={me.avatarUrl} alt="" referrerPolicy="no-referrer" />}
                <span>{firstName ?? me.email}</span>
              </span>
              <Link className="button button-small" to="/app">
                Go to your pages
              </Link>
            </>
          ) : (
            <>
              <Link to={LOGIN_URL}>Log in</Link>
              <Link className="button button-small" to={SIGNUP_URL}>
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>Your agent writes the page. You send the link.</h1>
            <p className="lede">
              The Artifact hosts the HTML pages your coding agent builds: reports, prototypes, dashboards. The agent publishes them through an MCP server, and
              you choose who can open them: anyone with the link, or only your team.
            </p>
            <div className="hero-actions">
              {signedIn ? (
                <Link className="button" to="/app">
                  Go to your pages
                </Link>
              ) : (
                <Link className="button" to={SIGNUP_URL}>
                  Get started free
                </Link>
              )}
              <a className="text-link" href="#how">
                See how it works
              </a>
            </div>
            <p className="hint">
              Works with Claude Code, Cursor, Codex, and any MCP client. Prefer your own servers? <Link to={SELF_HOSTING_URL}>Self-host for free</Link>.
            </p>
          </div>
          <FlowDemo />
        </section>

        <section id="how" className="section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <div className="step-text">
                <h3>Create a free account</h3>
                <p>{signedIn ? `Done. You are signed in as ${me!.email}.` : 'Sign up with your email. Your pages stay private until you share them.'}</p>
              </div>
              <div className="step-action">
                {signedIn ? (
                  <Link className="button button-quiet" to="/app">
                    Go to your pages
                  </Link>
                ) : (
                  <>
                    <Link className="button" to={SIGNUP_URL}>
                      Get started free
                    </Link>
                    <p className="step-link">
                      <Link className="text-link" to={SELF_HOSTING_URL}>
                        Or run it on your own server
                      </Link>
                    </p>
                  </>
                )}
              </div>
            </li>
            <li>
              <div className="step-text">
                <h3>Connect your agent</h3>
                <p>Add the MCP server once. The first time your agent publishes, it opens a browser window so you can sign in.</p>
              </div>
              <div className="step-action">
                <ConnectTabs />
              </div>
            </li>
            <li>
              <div className="step-text">
                <h3>Ask for a page</h3>
                <p>
                  Ask in plain words. The agent writes the page, calls <code>publish_artifact</code>, and replies with a link you can send.
                </p>
              </div>
              <div className="step-action">
                <div className="transcript" role="group" aria-label="Example request and reply">
                  <p>
                    <span className="caret" aria-hidden="true">
                      &gt;
                    </span>
                    turn this CSV into a chart I can send to the team
                  </p>
                  <p className="transcript-tool">
                    <span className="dot" aria-hidden="true" />
                    publish_artifact
                  </p>
                  <p>
                    Published. <mark>{APP_HOST}/a/signups-by-week</mark>
                  </p>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <section id="details" className="section details">
          <h2>What you get</h2>
          <dl>
            <div>
              <dt>One link for every revision</dt>
              <dd>Ask for a change and the agent republishes to the same URL. People who already have the link see the new version.</dd>
            </div>
            <div>
              <dt>Pages run in a sandbox</dt>
              <dd>Each page loads in an isolated frame, so scripts in an artifact can't reach the rest of the site.</dd>
            </div>
            <div>
              <dt>Private until you share it</dt>
              <dd>New pages are visible only to you. Share the link with anyone, or only with your organization.</dd>
            </div>
            <div>
              <dt>A gallery of everything published</dt>
              <dd>Every page your agents have published, newest first, with the agent that made it.</dd>
            </div>
          </dl>
        </section>

        <section id="pricing" className="section">
          <h2>Pricing</h2>
          <Pricing />
        </section>
      </main>

      <footer className="footer">
        <span>The Artifact</span>
        <span>andidev30</span>
      </footer>
    </>
  )
}
