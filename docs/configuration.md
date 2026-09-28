# Configuration reference

Settings are environment variables. With Docker Compose they go in `deploy/docker-compose/app.env`, except the ones Compose reads itself (`ARTIFACT_VERSION`, `ARTIFACT_PORT`, the passwords and `S3_*`), which go in `.env`. On Kubernetes they all go in `deploy/kubernetes/app.env`, or in Helm values, which name them differently (see [Install with Helm](/docs/kubernetes#install-with-helm)); `extraEnv` passes any of them as is. The Docker image sets the ones marked "set by the image".

## Required

| Variable | Meaning |
| --- | --- |
| `APP_URL` | Public address of the install, without a trailing slash, e.g. `https://artifact.example.com`. Sign-in links, page links, the MCP URL and OAuth metadata are built from it. Cookies are marked `Secure` when it starts with `https://`. Passkeys work only on its host name, so changing that makes existing passkeys unusable (people sign in another way and add new ones). |
| `DATABASE_URL` | Postgres connection string. `deploy/docker-compose/docker-compose.yml` sets it for its own database. |
| `S3_BUCKET` | Bucket for page content and thumbnails. `deploy/docker-compose/docker-compose.yml` sets it for its own MinIO. |

## Optional

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_PREPARE` | `true` | `false` when `DATABASE_URL` goes through a transaction-mode pooler (PgBouncer in transaction mode, Supabase's pooler on port 6543), which can't keep prepared statements |
| `WEB_CONCURRENCY` | one per CPU, at most 8 | How many Node.js processes (workers) serve requests. One process uses at most about one and a half cores, so a server with more gets more out of them with more workers: in a load test with 4 CPUs, 2 or 4 workers served about 1.5 times the page opens of one, and 4 workers twice the gallery requests. Empty counts the CPUs the app may use, including a container's CPU limit (`docker run --cpus`, a Kubernetes `resources.limits.cpu`), up to 8; a number from 1 to 64 sets it. `1` runs a single process, as before 0.5.0. Each worker takes about 250 MB of memory, so check the memory you give the app when you raise it. Work that must happen once per server runs in the first worker only: the [storage sweep](/docs/self-hosting#where-content-is-stored) and the thumbnail queue with its Chromium. Migrations and the bucket check run once, before the workers start. See [More than one worker](#more-than-one-worker). |
| `DATABASE_POOL_MAX` | 10 with one worker, 20 shared by more | Database connections each worker may open, from 1 to 1000. Empty gives 10 to a single process, and with more workers about 20 in all, at least 2 each: 10 each for 2, 5 each for 4, 2 each for 8. The server opens at most `WEB_CONCURRENCY` × `DATABASE_POOL_MAX` connections, which has to fit in Postgres's `max_connections` (100 by default) together with everything else that connects to it. A larger pool isn't faster: queries are short, and in a load test a pool of 40 served fewer requests than one of 10. |
| `CRON_SECRET` | empty | For hosts without a long-running server, like Vercel: turns on `GET /api/cron/sweep`, which a scheduler calls with `Authorization: Bearer <CRON_SECRET>` to run the [storage sweep](/docs/self-hosting#where-content-is-stored), which also deletes records of [who opened a page](/docs/sharing#who-opened-a-page) older than 90 days and expired [data exports](/docs/exporting-your-data), applies [version retention](/docs/retention), and spends up to 20 seconds building exports nobody has the settings page open for. It also turns on `GET /api/cron/webhooks`, which retries [webhook](/docs/webhooks) deliveries that failed (the sweep does this too); call it every few minutes where your scheduler allows, since retries are only as frequent as it runs. The Docker image doesn't need either; its server sweeps every 6 hours and sends webhooks within seconds on its own. |
| `CRON_SECRET` | empty | For hosts without a long-running server, like Vercel: turns on `GET /api/cron/sweep`, which a scheduler calls with `Authorization: Bearer <CRON_SECRET>` to run the [storage sweep](/docs/self-hosting#where-content-is-stored), which also deletes records of [who opened a page](/docs/sharing#who-opened-a-page) older than 90 days and expired [data exports](/docs/exporting-your-data), indexes up to 500 pages that [search](/docs/publishing#search) missed, applies [version retention](/docs/retention), and spends up to 20 seconds building exports nobody has the settings page open for. The Docker image doesn't need it; its server sweeps every 6 hours on its own. |
| `METRICS_TOKEN` | empty | Turns on Prometheus metrics at `GET /metrics`, which answers only requests with `Authorization: Bearer <METRICS_TOKEN>`. Empty means there is no `/metrics`. See [Health checks and metrics](/docs/self-hosting#health-checks-and-metrics). |
| `SMTP_HOST` | empty | Mail server for sign-in links, invitations, share emails and emails about new comments. Empty runs without email: password sign-in, and links admins pass on themselves. See [Running without email](/docs/self-hosting#running-without-email). |
| `SMTP_FROM` | `The Artifact <no-reply@localhost>` | Sender, e.g. `"The Artifact <artifact@example.com>"` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (usually port 465) |
| `SMTP_USER`, `SMTP_PASS` | empty | Leave empty for servers without authentication |
| `SALES_EMAIL` | the `SMTP_FROM` address | Where the **Contact sales** form sends messages. Each one has Reply-To set to the sender. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | empty | Enables **Continue with Google**. Register `APP_URL/api/auth/google/callback` as the redirect URI. |
| `CHROME_PATH` | empty (the image sets it) | Chrome or Chromium binary that renders gallery thumbnails and the pages agents check with [`inspect_artifact`](/docs/publishing#inspect_artifact). Empty skips thumbnails, cards show a sketch, and `inspect_artifact` answers that it isn't available. |
| `THUMBNAIL_CDN_HOSTS` | a built-in list | Comma-separated hosts pages may load scripts, styles and fonts from while their thumbnail renders, e.g. `cdn.jsdelivr.net,fonts.gstatic.com`. `none` blocks every host (pages that need a CDN then render without it). The built-in list: `cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `esm.sh`, `ga.jspm.io`, `cdn.skypack.dev`, `cdn.tailwindcss.com`, `code.jquery.com`, `d3js.org`, `cdn.plot.ly`, `fonts.googleapis.com`, `fonts.gstatic.com`, `rsms.me`. |
| `THUMBNAIL_CONCURRENCY` | `2` | How many thumbnails render at once, from 1 to 8, on the whole server: with several [workers](#more-than-one-worker), one of them renders every thumbnail. Each is a page in one shared Chromium, with the same network rules. A typical page renders in under a second, so 2 keeps up with about 150 new pages a minute and 4 with about 300. Raise it when `artifact_thumbnail_queue_length` keeps growing. Each render in progress is another Chromium page, so it costs some memory and CPU the requests could use: in a load test of small pages, 4 at once kept the whole app under 400 MB and half a core. |
| `EMBED_FRAME_ANCESTORS` | `*` | Which sites may [embed pages](/docs/sharing#embedding) in a frame. `*` lets any site. `none` allows only this install, which turns embedding off. Otherwise origins separated by spaces or commas, e.g. `https://www.notion.so https://*.atlassian.net`; each is `http(s)://host[:port]`, and `*.` matches subdomains. List every site in the chain of frames: some tools show embeds through an embedding service of their own, whose site has to be listed too. It applies to `/e/<page id>` and to page content; the rest of the app can only ever be framed by itself. |
| `CONTENT_ORIGIN` | empty | A second address that serves page files and nothing else, e.g. `https://artifact-content.example.net`. Pages then load from it instead of `APP_URL`, so the browser never sends the app's cookies to the place where untrusted pages run. It must be on another host than `APP_URL`, point at the same server, and preferably be on another registrable domain (see [A separate domain for pages](/docs/self-hosting#a-separate-domain-for-pages)). Page links, embeds, downloads, screenshots and link previews keep using `APP_URL`. Empty serves pages from `APP_URL`. |
| `TRUST_PROXY` | `false` | How many reverse proxies in front of the app add the visitor's address to `X-Forwarded-For`. `true` or `1` behind one proxy (Caddy, nginx, a Kubernetes ingress), `2` behind a CDN and a proxy. With `false`, the header is ignored, since anyone can send one, and every visitor has the proxy's address, so [per-network limits](/docs/configuration#rate-limits) count everyone together. See [Put it behind HTTPS](/docs/self-hosting#3-put-it-behind-https). |
| `RATE_LIMITS` | the built-in limits | `off` turns every [rate limit](/docs/configuration#rate-limits) off. Otherwise a comma-separated list of changes, each `name=count/window` or `name=off`, e.g. `sign-in-link=20/1h,mcp=1000/10m,invite-ip=off`. Windows are in `s`, `m`, `h` or `d`. Limits you don't list keep their defaults; an unknown name stops the server from starting. |
| `WORKSPACE_MAX_PAGES` | no limit | Most pages one workspace (a personal workspace or an organization) holds. See [Workspace quotas](/docs/configuration#workspace-quotas). |
| `WORKSPACE_MAX_VERSIONS` | no limit | Most versions of pages, all pages of one workspace together |
| `WORKSPACE_MAX_STORAGE` | no limit | Most storage one workspace uses, e.g. `10GB` or `500MB` (in powers of 1024) |
| `LICENSE_SIGNING_KEY` | empty | Hosted service only. The Ed25519 private key that signs [license keys](/docs/licenses#issue-license-keys-on-the-hosted-service) for self-hosted installs, as printed by `license:keygen`. Empty means **Server admin** can't issue keys. A self-hosted install never needs it; it checks keys with the public keys in its code. |
| `RELEASE_CHECK` | `true` | Once a day, when an admin opens **Server admin**, the server asks GitHub's public releases API (`api.github.com/repos/andidev30/the-artifact/releases`) for the newest release and shows a notice when it is newer than the one running. Nothing about the install is sent. `false` makes no request at all, for servers without internet access. Only self-hosted installs check. See [New releases](/docs/upgrading#new-releases). |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Days organizations' [audit log](/docs/audit-log) events are kept, a whole number of at least 1. The storage sweep deletes older ones every 6 hours. An Enterprise feature. |
| `SELF_HOSTED` | `true` | Skips the marketing pages; `/` opens the app. Also makes the first account the instance admin. Only the hosted service sets it to `false`. |
| `PORT` | `3000` | Port inside the container |
| `ARTIFACT_VERSION` | the release the compose file was written for | Release of `ghcr.io/andidev30/the-artifact` that `deploy/docker-compose/docker-compose.yml` runs: an exact version like `0.2.0`, or a major.minor like `0.2`. Set it in the `.env` next to the compose file. See [Upgrading](/docs/upgrading). |
| `ARTIFACT_PORT` | `8080` | Host port in `deploy/docker-compose/docker-compose.yml` |
| `POSTGRES_PASSWORD` | `artifact` | Database password in `deploy/docker-compose/docker-compose.yml`; set it in a `.env` file next to the compose file before the first start |

## More than one worker

With `WEB_CONCURRENCY` above 1, the server starts a primary process and that many workers, which share its port. The primary serves nothing itself: it migrates the database and checks the bucket, starts the workers, and starts a worker again when one stops, waiting a little longer each time one keeps crashing (up to 30 seconds). On `SIGTERM` (`docker compose stop`, a Kubernetes rollout) every worker stops taking new connections, finishes the requests it has for up to 8 seconds, writes what it still has to write, and exits.

The first worker also runs the storage sweep, sends [webhooks](/docs/webhooks), and renders every thumbnail and every `inspect_artifact` check; the others hand it the pages to render and, for checks, pass its answer back. Everything else is shared through Postgres, such as rate limits, so it doesn't matter which worker answers. A few things are kept in each worker's memory, which is fine but worth knowing:

- Recently read content (up to 64 MB) and the file lists of recent versions: each worker keeps its own, so more workers use more memory.
- Repeat [page views](/docs/sharing#who-opened-a-page): a visitor who opens the same page again within 30 minutes isn't counted again, but each worker remembers this on its own, so a repeat visit that another worker answers can be counted once more. People who are signed in are checked in the database too, so this only affects visits by link.
- Whether the server has an account yet, for the setup form: up to a minute old in each worker.

`/metrics` answers for the whole server whichever worker gets the scrape: counters and histograms are added up over the workers, as are the pool gauges (so `artifact_db_pool_max` is the total), and `artifact_nodejs_eventloop_lag_*` is averaged. The primary's own process isn't included.

## Object storage

Any service with the S3 API works: MinIO, AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage (interoperability keys). `deploy/docker-compose/docker-compose.yml` points these at its bundled MinIO unless you set them in the `.env` next to it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_ENDPOINT` | empty (AWS S3) | e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com` |
| `S3_REGION` | `us-east-1` | `auto` for R2 |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | empty | Without them, the AWS SDK's usual credential chain applies (environment, IAM role) |
| `S3_PUBLIC_ENDPOINT` | empty | Where agents can reach the bucket themselves, e.g. `https://<account>.r2.cloudflarestorage.com`. Turns on [publishing by direct upload](/docs/publishing#publishing-by-direct-upload), and [data exports](/docs/exporting-your-data) download straight from the bucket through links that work for 5 minutes. Empty keeps publishing inline only and sends exports through the app, which is right when the bucket is on a private network, like the bundled MinIO. |
| `MINIO_ROOT_PASSWORD` | `artifact-secret` | Password of the bundled MinIO in `deploy/docker-compose/docker-compose.yml`; set it in the `.env` next to the compose file before the first start |

With `S3_ENDPOINT` set, the app uses `bucket/key` addresses (path style), which MinIO and most other stores need. It creates the bucket on start if it doesn't exist; without permission to do that, create it yourself. Besides that, the app only needs to read, write, list and delete objects in its bucket. Keep the bucket private: with `S3_PUBLIC_ENDPOINT` set, agents write to it only through upload links that expire after 15 minutes, into a staging area the app checks before anything is published.

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
| License key | Self-hosted installs only. Turns on enterprise features; see [Licenses](/docs/licenses) |

## Limits

| What | Limit |
| --- | --- |
| Page size | 2 MB of HTML |
| Files per page | 100 besides the HTML, each up to 5 MB |
| Page and files together | 10 MB |
| File path | 200 characters |
| Thumbnail render | 8 seconds to load, 20 in all; 640×360 WebP of a 1280×720 viewport |
| Page inspection (`inspect_artifact`) | The same timeouts for each width; screenshots 1280 or 390 pixels wide and up to 2,000 tall; `THUMBNAIL_CONCURRENCY` at once besides thumbnails, with up to 20 more waiting at most 30 seconds; up to 1,000 distinct console errors and 1,000 broken links collected, the first 20 of each shown |
| Page title | 200 characters |
| Folders | 500 per workspace, names up to 80 characters |
| Tags | 10 per page, each 1 to 32 characters |
| Search | The first 200,000 characters of a page's text |
| Gallery and `list_artifacts` | 50 and 25 pages at a time by default, at most 100 |
| People per share | 20 at a time |
| Comment | 5,000 characters of plain text; comments load 100 threads at a time in the app, 50 by default in `list_comments` |
| Sign-in link | Works once, for 15 minutes, and is used when you press Continue on the page it opens (opening it alone uses nothing); a new one can be sent after 60 seconds |
| Organization invitation | 7 days |
| Browser session | 30 days, extended while you use it |
| Two-factor sign-in | 10 minutes to finish the second step; changes to it need a sign-in from the last hour |
| Passkeys | 20 per account, names up to 60 characters |
| Recovery codes | 10, each works once |
| Agent access token | 1 hour, refreshed automatically; refresh tokens last 60 days and rotate on use |
| Webhooks | 20 per workspace, addresses up to 2,000 characters; 5 seconds per request, six tries over a little more than an hour; delivery logs kept 14 days |
| Access token for CI | 7, 30 or 90 days, 1 year, or no expiry, as chosen when it is made (90 days by default); names up to 60 characters |
| Requests | See [Rate limits](/docs/configuration#rate-limits) |
| Pages, versions and storage per workspace | None unless set; see [Workspace quotas](/docs/configuration#workspace-quotas) |

## Rate limits

Each limit counts something for one key (an email address, an account, or a network) in a window that starts with the first request and lasts the time shown. Past the limit, the server answers `429 Too Many Requests` with a `Retry-After` header and a message that says how long to wait, which the app shows as is. Agents get the message as the tool's error instead, which they read and pass on (an HTTP error would reach most MCP clients as a failed request, without it). A request that is refused isn't counted.

| Name | What is counted | Default |
| --- | --- | --- |
| `sign-in-link` | Sign-in links emailed to one address, besides at most one per 60 seconds | 10 per hour |
| `sign-in-link-ip` | Sign-in links asked for from one network | 30 per hour |
| `password` | Wrong passwords for one address, at sign-in and as the current password when changing it. Entering the right one resets it. | 10 per 15 minutes |
| `password-ip` | Password sign-ins, sign-ups and first-account setups from one network | 100 per 15 minutes |
| `two-factor` | Wrong authenticator app and recovery codes for one account, when signing in or turning the app on. Entering a right one resets it. | 10 per hour |
| `two-factor-ip` | [Second-factor steps](/docs/security#two-factor-sign-in) and passkey sign-ins from one network | 100 per 15 minutes |
| `sso-ip` | [Single sign-on](/docs/sso) sign-ins started and finished from one network | 100 per 15 minutes |
| `saml-ip` | Answers from [SAML](/docs/saml) identity providers arriving from one network | 100 per 15 minutes |
| `scim` | [SCIM](/docs/scim) requests with one token | 2,000 per 10 minutes |
| `two-factor-setup` | Passkeys, authenticator app set-ups and new recovery codes one account asks for in **Account settings** | 30 per hour |
| `oauth-register-ip` | Agents registering with the server (`POST /oauth/register`) from one network, which each agent does once when it connects | 60 per hour |
| `invite` | People one account invites to an organization or shares a page with by email, in the app or through an agent | 200 per hour |
| `invite-ip` | The same, from one network | 500 per hour |
| `mcp` | MCP tool calls by one account, all agents together | 600 per 10 minutes |
| `publish` | New pages and versions one account publishes through agents (`publish_artifact`, `update_files`, `publish_upload`, `restore_version`, `duplicate_artifact`, also counted in `mcp`), with an access token (`POST /api/publish`), or by duplicating a page in the app | 200 per hour |
| `inspect` | Pages one account has opened on the server with `inspect_artifact`, each a few seconds of Chromium (also counted in `mcp`) | 100 per hour |
| `access-token` | [Access tokens](/docs/connect-your-agent#publishing-from-ci) one account creates in **Account settings** | 20 per hour |
| `comment` | Comments and replies one account writes, in the app or through agents (`add_comment`, `reply_comment`) | 120 per hour |
| `link-password` | Wrong passwords for one page's link, from anyone; right ones don't count. Past it, nobody can try until the window ends. | 30 per 15 minutes |
| `link-password-ip` | Link password attempts from one network, right or wrong | 100 per 15 minutes |
| `comment-email` | Emails to one person about new comments on one page. Comments past it send nothing and show as new in the app, so a burst of comments is one email. | 1 per 15 minutes |
| `data-export` | [Data exports](/docs/exporting-your-data) of one account, and of one organization. One that fails doesn't count. | 1 per hour |
| `webhook` | [Webhooks](/docs/webhooks) one account adds, and test messages it sends | 60 per hour |
| `webhook-page-opened` | **Page opened** events one webhook sends for one page. Opens past it send nothing. | 1 per 10 minutes |

A network is one IPv4 address, or one IPv6 `/64`. The app knows a visitor's address from the connection, or from `X-Forwarded-For` when `TRUST_PROXY` says a proxy sets it. The counters are kept in Postgres, so every replica of the app shares them; the storage sweep clears the ones that ran out.

Change or turn off single limits with `RATE_LIMITS`, e.g. `RATE_LIMITS=mcp=2000/10m,publish=500/1h` for a team whose agents publish a lot, or `RATE_LIMITS=off` for none.

## Workspace quotas

A self-hosted server has no quotas unless you set them. `WORKSPACE_MAX_PAGES`, `WORKSPACE_MAX_VERSIONS` and `WORKSPACE_MAX_STORAGE` apply to every workspace: each person's personal workspace, and each organization as a whole. They are checked when a page or a version is added, so a server that already holds more keeps it and only refuses new ones.

Storage is the size of every version of every page in the workspace, the HTML and its files, each version counted in full as its history shows it (content that versions share is stored once, but counting it once would make the total something people can't work out). Restoring a version adds a version, so it counts too. Deleting a page frees what its versions used. [Duplicating a page](/docs/sharing#duplicating-a-page) adds a page and one version; [moving one in](/docs/sharing#moving-a-page-to-another-workspace) from another workspace adds the page with all its versions, and frees them in the workspace it left.

When a publish would go past a quota, the agent gets an error that says which one and what to do, e.g. "Your personal workspace has 500 pages, the most this server allows. Publish a new version of a page you have (pass its artifact_id), or delete one you no longer need in the gallery." Restoring a version, duplicating a page or moving one to another workspace in the app shows the same message.

On the hosted service, the free Personal plan holds 50 pages and 1 GB of storage in a personal workspace, and keeps older versions for 7 days. Organizations have no quota there. New organizations can't be created there until the Organization plan has billing; see [Organizations](/docs/organizations#creating-one).
