# Self-hosting The Artifact

The Artifact runs as one Docker image next to a Postgres database. It is free to self-host, with every feature included.

## What you need

- A server with Docker and Docker Compose
- An SMTP server for sign-in links, invitations and share emails
- A domain name pointing at the server, if people outside your network will use it

## 1. Get the code and configure it

```sh
git clone <repository-url> the-artifact
cd the-artifact
cp .env.selfhost.example .env.selfhost
```

Edit `.env.selfhost`:

| Setting | What to put there |
| --- | --- |
| `APP_URL` | The address people use, e.g. `https://artifact.example.com`. Links in emails and the MCP URL are built from it. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Your mail server. |
| `ALLOWED_EMAIL_DOMAINS` | Optional. Comma-separated domains that may create accounts, e.g. `example.com`. People from other domains can still join when they are invited to an organization or a page. Leave it empty to let anyone sign up. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Without them people sign in by email only. |

## 2. Start it

```sh
docker compose -f docker-compose.selfhost.yml up -d
```

The app listens on port 8080 (change it with `ARTIFACT_PORT=9000`). It creates and updates its database tables on every start. Open `APP_URL` and create the first account.

The database password defaults to `artifact` and the database is only reachable from the app container. To change it, set `POSTGRES_PASSWORD` in a `.env` file next to `docker-compose.selfhost.yml` before the first start.

## 3. Put it behind HTTPS

Agents and browsers should reach The Artifact over HTTPS. Any reverse proxy works. With Caddy:

```
artifact.example.com {
  reverse_proxy localhost:8080
}
```

Then set `APP_URL=https://artifact.example.com` and restart with `docker compose -f docker-compose.selfhost.yml up -d`.

## 4. Connect agents

Each person adds the MCP server once, using `APP_URL` followed by `/mcp`:

```sh
claude mcp add --transport http --scope user the-artifact https://artifact.example.com/mcp
```

The pages screen shows the setup for Claude Code, Cursor, Codex and other MCP clients.

## Google sign-in (optional)

In Google Cloud Console, create an OAuth client of type Web application. Add `APP_URL` as an authorized JavaScript origin and `APP_URL/api/auth/google/callback` as the redirect URI, then put the client ID and secret in `.env.selfhost` and restart.

## Updating

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Database changes apply automatically when the new version starts.

## Backups

Everything lives in Postgres, including page HTML and version history:

```sh
docker compose -f docker-compose.selfhost.yml exec db pg_dump -U artifact artifact > artifact-backup.sql
```
