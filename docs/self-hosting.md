# Self-hosting

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

Every setting is listed in the [configuration reference](/docs/configuration).

## 2. Start it

```sh
docker compose -f docker-compose.selfhost.yml up -d
```

The app listens on port 8080 (change it with `ARTIFACT_PORT=9000`). It creates and updates its database tables on every start. Open `APP_URL` and create the first account.

The image includes a headless Chromium for gallery thumbnails. The compose file runs the app with `docker/seccomp-chromium.json` so Chromium can keep its sandbox on (see [Security](/docs/security)); keep that line if you write your own compose file or Kubernetes manifest, or the log will say thumbnails are off.

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

See [Connect your agent](/docs/connect-your-agent) for Cursor, Codex and other MCP clients.

## Google sign-in (optional)

In Google Cloud Console, create an OAuth client of type Web application. Add `APP_URL` as an authorized JavaScript origin and `APP_URL/api/auth/google/callback` as the redirect URI, then put the client ID and secret in `.env.selfhost` and restart.

## Updating

```sh
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Database changes apply automatically when the new version starts. Pages published before thumbnails existed get theirs the first time the gallery lists them; to render them all at once:

```sh
docker compose -f docker-compose.selfhost.yml exec app node dist/scripts/backfill-thumbnails.js
```

## Backups

Everything lives in Postgres, including page HTML, files, thumbnails and version history:

```sh
docker compose -f docker-compose.selfhost.yml exec db pg_dump -U artifact artifact > artifact-backup.sql
```
