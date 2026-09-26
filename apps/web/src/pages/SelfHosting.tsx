import { useEffect } from 'react'
import { Link } from 'react-router'
import { CopyCommand } from '../components/CopyCommand'
import { Wordmark } from '../components/Wordmark'
import { CONTACT_SALES_URL } from '../config'
import './SelfHosting.css'

const SETTINGS = [
  ['APP_URL', 'The address people use, like https://artifact.example.com. Links in emails and the MCP URL are built from it.'],
  ['SMTP_*', 'Your mail server, for sign-in links, invitations and share emails.'],
  ['ALLOWED_EMAIL_DOMAINS', 'Optional. Domains that may create accounts, like example.com. People from other domains can still join what they are invited to.'],
  ['GOOGLE_CLIENT_*', 'Optional. Without them people sign in by email only.'],
] as const

// The install guide, kept in step with SELF_HOSTING.md at the repository root
export function SelfHosting() {
  useEffect(() => {
    document.title = 'Self-host The Artifact'
    return () => { document.title = 'The Artifact' }
  }, [])

  return (
    <>
      <header className="nav">
        <Wordmark />
        <nav aria-label="Primary">
          <Link className="nav-section" to="/#pricing">Pricing</Link>
          <Link to={`${CONTACT_SALES_URL}?topic=self-hosted-enterprise`}>Talk to us</Link>
        </nav>
      </header>

      <main id="main" className="guide">
        <div className="guide-intro">
          <h1>Self-host The Artifact</h1>
          <p className="lede">
            One Docker image and a Postgres database, on your own server. Free, with every feature:
            organizations, sharing and version history. Your pages never leave your network.
          </p>
          <p className="guide-needs">
            You need a server with Docker, an SMTP server for sign-in emails, and a domain if people
            outside your network will use it.
          </p>
        </div>

        <ol className="steps guide-steps">
          <li>
            <div className="step-text">
              <h2>Get the code and configure it</h2>
              <p>Copy the example settings, then fill in your address and mail server.</p>
            </div>
            <div className="step-action">
              <CopyCommand command="git clone <repository-url> the-artifact && cd the-artifact" label="Copy the clone command" />
              <CopyCommand command="cp .env.selfhost.example .env.selfhost" label="Copy the configure command" />
              <dl className="guide-settings">
                {SETTINGS.map(([name, text]) => (
                  <div key={name}>
                    <dt><code>{name}</code></dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </li>
          <li>
            <div className="step-text">
              <h2>Start it</h2>
              <p>
                It listens on port 8080 and creates or updates its database tables on every start. Open
                your address and create the first account.
              </p>
            </div>
            <div className="step-action">
              <CopyCommand command="docker compose -f docker-compose.selfhost.yml up -d" label="Copy the start command" />
            </div>
          </li>
          <li>
            <div className="step-text">
              <h2>Put it behind HTTPS</h2>
              <p>Agents and browsers should reach it over HTTPS. Any reverse proxy works; this is Caddy.</p>
            </div>
            <div className="step-action">
              <CopyCommand file="Caddyfile" command={'artifact.example.com {\n  reverse_proxy localhost:8080\n}'} label="Copy the Caddy config" />
            </div>
          </li>
          <li>
            <div className="step-text">
              <h2>Connect your agents</h2>
              <p>
                Each person adds the MCP server once, using your address followed by <code>/mcp</code>. The
                pages screen shows the setup for Claude Code, Cursor, Codex and other clients.
              </p>
            </div>
            <div className="step-action">
              <CopyCommand command="claude mcp add --transport http --scope user the-artifact https://artifact.example.com/mcp" label="Copy the Claude Code command" />
            </div>
          </li>
        </ol>

        <section className="guide-more" aria-label="Keeping it running">
          <div>
            <h2>Updating</h2>
            <p>Database changes apply automatically when the new version starts.</p>
            <CopyCommand command="git pull && docker compose -f docker-compose.selfhost.yml up -d --build" label="Copy the update command" />
          </div>
          <div>
            <h2>Backups</h2>
            <p>Everything lives in Postgres, including page HTML and version history.</p>
            <CopyCommand command="docker compose -f docker-compose.selfhost.yml exec db pg_dump -U artifact artifact > artifact-backup.sql" label="Copy the backup command" />
          </div>
        </section>

        <p className="guide-footer">
          Need SSO, audit logs or help rolling it out? <Link className="text-link" to={`${CONTACT_SALES_URL}?topic=self-hosted-enterprise`}>Talk to us about Self-hosted Enterprise</Link>.
        </p>
      </main>
    </>
  )
}
