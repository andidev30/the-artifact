# Configuration reference

Settings are environment variables. With Docker Compose they go in `.env.selfhost`, except the ones Compose reads itself (`ARTIFACT_PORT`, the passwords and `S3_*`), which go in `.env`. On Kubernetes they all go in `deploy/kubernetes/app.env`. The Docker image sets the ones marked "set by the image".

## Required

| Variable | Meaning |
| --- | --- |
| `APP_URL` | Public address of the install, without a trailing slash, e.g. `https://artifact.example.com`. Sign-in links, page links, the MCP URL and OAuth metadata are built from it. Cookies are marked `Secure` when it starts with `https://`. |
| `DATABASE_URL` | Postgres connection string. `docker-compose.selfhost.yml` sets it for its own database. |
| `S3_BUCKET` | Bucket for page content and thumbnails. `docker-compose.selfhost.yml` sets it for its own MinIO. |

## Optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` | empty | Mail server for sign-in links, invitations and share emails. Empty runs without email: password sign-in, and links admins pass on themselves. See [Running without email](/docs/self-hosting#running-without-email). |
| `SMTP_FROM` | `The Artifact <no-reply@localhost>` | Sender, e.g. `"The Artifact <artifact@example.com>"` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465) |
| `SMTP_USER`, `SMTP_PASS` | empty | Leave empty for servers without authentication |
| `SALES_EMAIL` | the `SMTP_FROM` address | Where the **Contact sales** form sends messages. Each one has Reply-To set to the sender. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Enables **Continue with Google**. Register `APP_URL/api/auth/google/callback` as the redirect URI. |
| `CHROME_PATH` | empty (the image sets it) | Chrome or Chromium binary that renders gallery thumbnails. Empty skips thumbnails; cards show a sketch. |
| `THUMBNAIL_CDN_HOSTS` | a built-in list | Comma-separated hosts pages may load scripts, styles and fonts from while their thumbnail renders, e.g. `cdn.jsdelivr.net,fonts.gstatic.com`. `none` blocks every host (pages that need a CDN then render without it). The built-in list: `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `esm.sh`, `ga.jspm.io`, `cdn.skypack.dev`, `cdn.tailwindcss.com`, `code.jquery.com`, `d3js.org`, `cdn.plot.ly`, `fonts.googleapis.com`, `fonts.gstatic.com`, `rsms.me`. |
| `SELF_HOSTED` | `true` | Skips the marketing pages; `/` opens the app. Also makes the first account the instance admin. Only the hosted service sets it to `false`. |
| `PORT` | `3000` | Port inside the container |
| `ARTIFACT_PORT` | `8080` | Host port in `docker-compose.selfhost.yml` |
| `POSTGRES_PASSWORD` | `artifact` | Database password in `docker-compose.selfhost.yml`; set it in a `.env` file next to the compose file before the first start |

## Object storage

Any service with the S3 API works: MinIO, AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage (interoperability keys). `docker-compose.selfhost.yml` points these at its bundled MinIO unless you set them in the `.env` next to it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_ENDPOINT` | empty (AWS S3) | e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION` | `us-east-1` | `auto` for R2 |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | empty | Without them, the AWS SDK's usual credential chain applies (environment, IAM role) |
| `MINIO_ROOT_PASSWORD` | `artifact-secret` | Password of the bundled MinIO in `docker-compose.selfhost.yml`; set it in the `.env` next to the compose file before the first start |

With `S3_ENDPOINT` set, the app uses `bucket/key` addresses (path style), which MinIO and most other stores need. It creates the bucket on start if it doesn't exist; without permission to do that, create it yourself. Besides that, the app only needs to read, write, list and delete objects in its bucket. Keep the bucket private.

## Set by the image

| Variable | Value | Meaning |
| --- | --- | --- |
| `WEB_DIR` | `/app/web` | Serves the built web app from the same process |
| `MIGRATE_ON_START` | `true` | Applies database migrations on every start |
| `CHROME_PATH` | `/usr/bin/chromium-headless-shell` | Renders gallery thumbnails |

## Settings in Server admin

Instance admins change these under **Server admin** (`/admin`); they are stored in the database and apply at once, without a restart.

| Setting | Meaning |
| --- | --- |
| Sign-up policy | Anyone, listed email domains, or invited people only. Anyone until it is saved. |
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
