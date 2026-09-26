import { ConnectTabs } from './components/ConnectTabs'
import { CopyCommand } from './components/CopyCommand'
import { FlowDemo } from './components/FlowDemo'
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
          <a href="#how">How it works</a>
          <a href="#details">Details</a>
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <h1>Your agent writes the page. You send the link.</h1>
            <p className="lede">
              The Artifact hosts the HTML pages your coding agent builds: reports,
              prototypes, dashboards. The agent publishes them through an MCP server,
              and anyone with the link can open them in a browser.
            </p>
            <div className="hero-actions">
              <a className="button" href="#how">Set up in 3 steps</a>
              <p className="hint">Works with Claude Code, Cursor, Codex, and any MCP client.</p>
            </div>
          </div>
          <FlowDemo />
        </section>

        <section id="how" className="section">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <div className="step-text">
                <h3>Start the server</h3>
                <p>The Artifact runs on your own machine or server. Run this from the repo root.</p>
              </div>
              <div className="step-action">
                <CopyCommand command="pnpm install && pnpm dev:api" label="Copy the start command" />
              </div>
            </li>
            <li>
              <div className="step-text">
                <h3>Connect your agent</h3>
                <p>Add the MCP server once. Pick the agent you use and copy its setup.</p>
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
                  <p>Published. <mark>artifact.local/a/signups-by-week</mark></p>
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
              <dt>Files stay on your server</dt>
              <dd>Artifacts are stored where you host The Artifact. Nothing goes to a third party.</dd>
            </div>
            <div>
              <dt>A gallery of everything published</dt>
              <dd>Every page your agents have published, newest first, with the agent that made it.</dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="footer">
        <span>The Artifact</span>
        <span>A self-hosted home for pages made by coding agents.</span>
      </footer>
    </>
  )
}

export default App
