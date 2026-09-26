import { ConnectTabs } from './components/ConnectTabs'
import { FlowDemo } from './components/FlowDemo'
import { Pricing } from './components/Pricing'
import { APP_HOST, LOGIN_URL, SIGNUP_URL } from './config'
import './App.css'

function App() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <header className="nav">
        <a className="wordmark" href="/">
          <span className="wordmark-mark" aria-hidden="true" />
          the artifact
        </a>
        <nav aria-label="Primary">
          <a className="nav-section" href="#how">How it works</a>
          <a className="nav-section" href="#pricing">Pricing</a>
          <a href={LOGIN_URL}>Log in</a>
          <a className="button button-small" href={SIGNUP_URL}>Get started</a>
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>Your agent writes the page. You send the link.</h1>
            <p className="lede">
              The Artifact hosts the HTML pages your coding agent builds: reports,
              prototypes, dashboards. The agent publishes them through an MCP server,
              and you choose who can open them: anyone with the link, or only your team.
            </p>
            <div className="hero-actions">
              <a className="button" href={SIGNUP_URL}>Get started free</a>
              <a className="text-link" href="#how">See how it works</a>
            </div>
            <p className="hint">Works with Claude Code, Cursor, Codex, and any MCP client.</p>
          </div>
          <FlowDemo />
        </section>

        <section id="how" className="section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <div className="step-text">
                <h3>Create an account</h3>
                <p>Sign up with your email or GitHub. Personal use is free.</p>
              </div>
              <div className="step-action">
                <a className="button button-quiet" href={SIGNUP_URL}>Create a free account</a>
              </div>
            </li>
            <li>
              <div className="step-text">
                <h3>Connect your agent</h3>
                <p>
                  Add the MCP server once. The first time your agent publishes, it opens a
                  browser window so you can sign in.
                </p>
              </div>
              <div className="step-action">
                <ConnectTabs />
              </div>
            </li>
            <li>
              <div className="step-text">
                <h3>Ask for a page</h3>
                <p>
                  Ask in plain words. The agent writes the page, calls{' '}
                  <code>publish_artifact</code>, and replies with a link you can send.
                </p>
              </div>
              <div className="step-action">
                <div className="transcript" aria-label="Example request and reply">
                  <p><span className="caret" aria-hidden="true">&gt;</span>turn this CSV into a chart I can send to the team</p>
                  <p className="transcript-tool"><span className="dot" aria-hidden="true" />publish_artifact</p>
                  <p>Published. <mark>{APP_HOST}/a/signups-by-week</mark></p>
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
          <p className="section-lede">Free for your own work. Pay when your team shares a workspace. Talk to us when your company needs SSO and audit logs.</p>
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

export default App
