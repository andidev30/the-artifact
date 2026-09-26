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
| `ALLOWED_EMAIL_DOMAINS` | empty | Comma-separated domains that may create accounts. Empty lets anyone sign up. People invited to an organization or a page can always join. Used until an instance admin saves a sign-up policy in the admin area, which then takes precedence. |
| `ADMIN_EMAILS` | empty | Comma-separated addresses that are always instance admins and can always sign up. They can't be demoted or deleted from the admin area. See [The instance admin](/docs/self-hosting#the-instance-admin). |
| `FIRST_USER_ADMIN` | same as `SELF_HOSTED` | `true` makes the first account created on the install its admin. `false` turns that off. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Enables **Continue with Google**. Register `APP_URL/api/auth/google/callback` as the redirect URI. |
| `CHROME_PATH` | empty (the image sets it) | Chrome or Chromium binary that renders gallery thumbnails. Empty skips thumbnails; cards show a sketch. |
| `THUMBNAIL_CDN_HOSTS` | a built-in list | Comma-separated hosts pages may load scripts, styles and fonts from while their thumbnail renders, e.g. `cdn.jsdelivr.net,fonts.gstatic.com`. `none` blocks every host (pages that need a CDN then render without it). The built-in list: `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `esm.sh`, `ga.jspm.io`, `cdn.skypack.dev`, `cdn.tailwindcss.com`, `code.jquery.com`, `d3js.org`, `cdn.plot.ly`, `fonts.googleapis.com`, `fonts.gstatic.com`, `rsms.me`. |
| `CHROME_NO_SANDBOX` | `false` | `true` runs Chromium without its sandbox. Only for containers isolated some other way; see [Security](/docs/security). |
| `PORT` | `3000` | Port inside the container |
| `ARTIFACT_PORT` | `8080` | Host port in `docker-compose.selfhost.yml` |
| `POSTGRES_PASSWORD` | `artifact` | Database password in `docker-compose.selfhost.yml`; set it in a `.env` file next to the compose file before the first start |

## Set by the image

| Variable | Value | Meaning |
| --- | --- | --- |
| `SELF_HOSTED` | `true` | Skips the marketing pages; `/` opens the app. Also makes the first account the instance admin, unless `FIRST_USER_ADMIN=false`. |
| `WEB_DIR` | `/app/web` | Serves the built web app from the same process |
| `MIGRATE_ON_START` | `true` | Applies database migrations on every start |
| `CHROME_PATH` | `/usr/bin/chromium-headless-shell` | Renders gallery thumbnails |

## Settings in the admin area

Instance admins change these at `/admin`; they are stored in the database and apply at once, without a restart.

| Setting | Meaning |
| --- | --- |
| Sign-up policy | Anyone, listed email domains, or invited people only. Takes precedence over `ALLOWED_EMAIL_DOMAINS` once saved. |
| Instance name | Optional, up to 60 characters, shown next to the logo in the signed-in header |

## Limits

| What | Limit |
| --- | --- |
| Page size | 2 MB of HTML |
| Files per page | 100 besides the HTML, each up to 5 MB |
| Page and files together | 10 MB |
| File path | 200 characters |
| Thumbnail render | 8 seconds to load, 20 in all; 640×360 WebP of a 1280×720 viewport |
| Page title | 200 characters |
| People per share | 20 at a time |
| Sign-in link | Works once, for 15 minutes, and is used when you press Continue on the page it opens (opening it alone uses nothing); a new one can be sent after 60 seconds |
| Organization invitation | 7 days |
| Browser session | 30 days, extended while you use it |
| Agent access token | 1 hour, refreshed automatically; refresh tokens last 60 days and rotate on use |
