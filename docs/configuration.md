# Configuration reference

Settings are environment variables. For a self-hosted install they go in `.env.selfhost`; the Docker image sets the ones marked "set by the image".

## Required

| Variable | Meaning |
| --- | --- |
| `APP_URL` | Public address of the install, without a trailing slash, e.g. `https://artifact.example.com`. Sign-in links, page links, the MCP URL and OAuth metadata are built from it. Cookies are marked `Secure` when it starts with `https://`. |
| `DATABASE_URL` | Postgres connection string. `docker-compose.selfhost.yml` sets it for its own database. |
| `SMTP_HOST` | Mail server for sign-in links, invitations and share emails |
| `SMTP_FROM` | Sender, e.g. `"The Artifact <artifact@example.com>"` |

## Optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465) |
| `SMTP_USER`, `SMTP_PASS` | empty | Leave empty for servers without authentication |
| `ALLOWED_EMAIL_DOMAINS` | empty | Comma-separated domains that may create accounts. Empty lets anyone sign up. People invited to an organization or a page can always join. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Enables **Continue with Google**. Register `APP_URL/api/auth/google/callback` as the redirect URI. |
| `PORT` | `3000` | Port inside the container |
| `ARTIFACT_PORT` | `8080` | Host port in `docker-compose.selfhost.yml` |
| `POSTGRES_PASSWORD` | `artifact` | Database password in `docker-compose.selfhost.yml`; set it in a `.env` file next to the compose file before the first start |

## Set by the image

| Variable | Value | Meaning |
| --- | --- | --- |
| `SELF_HOSTED` | `true` | Skips the marketing pages; `/` opens the app |
| `WEB_DIR` | `/app/web` | Serves the built web app from the same process |
| `MIGRATE_ON_START` | `true` | Applies database migrations on every start |

## Limits

| What | Limit |
| --- | --- |
| Page size | 2 MB of HTML |
| Page title | 200 characters |
| People per share | 20 at a time |
| Sign-in link | Works once, for 15 minutes, and is used when you press Continue on the page it opens (opening it alone uses nothing); a new one can be sent after 60 seconds |
| Organization invitation | 7 days |
| Browser session | 30 days, extended while you use it |
| Agent access token | 1 hour, refreshed automatically; refresh tokens last 60 days and rotate on use |
