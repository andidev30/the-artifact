# Self-hosting

The Artifact runs as one Docker image next to a Postgres database and an S3-compatible object store. The compose file brings all three, with MinIO as the object store. The app image is published as `ghcr.io/andidev30/the-artifact` for `linux/amd64` and `linux/arm64`, so nothing is built on your server unless you [build it yourself](#building-the-image-yourself). It is free to self-host, with every feature included. This page uses Docker Compose; for a cluster, see [Kubernetes](/docs/kubernetes).

## What you need

- A server with Docker and Docker Compose
- Optional: an SMTP server for sign-in links, invitations and share emails. Without one, people log in with a password (see [Running without email](#running-without-email))
- A domain name pointing at the server, if people outside your network will use it

## 1. Get the code and configure it

```sh
git clone <repository-url> the-artifact
cd the-artifact/deploy/docker-compose
cp app.env.example app.env
cp .env.example .env
```

Everything for Docker Compose is in `deploy/docker-compose`, and every `docker compose` command in these docs runs there. There are two files because Docker Compose reads some settings itself. Edit `app.env`, the app's settings:

| Setting | What to put there |
| --- | --- |
| `APP_URL` | The address people use, e.g. `https://artifact.example.com`. Links in emails and the MCP URL are built from it. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional. Your mail server. Leave `SMTP_HOST` empty to [run without email](#running-without-email). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Without them the **Continue with Google** button is hidden. |

And `.env`, read by Docker Compose, before the first start (the database and MinIO keep the passwords they were created with):

| Setting | What to put there |
| --- | --- |
| `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` | Passwords of the bundled Postgres and MinIO. Neither is reachable from outside the compose network. Without the file they default to `artifact` and `artifact-secret`. |
| `ARTIFACT_VERSION` | Optional. The release to run, e.g. `0.1.0`. Without it, the compose file runs the release it was written for. Releases are listed at https://github.com/andidev30/the-artifact/releases. |
| `ARTIFACT_PORT` | Optional. Port on the host, `8080` by default. |
| `S3_*` | Optional. Object storage elsewhere; see [Using S3, R2 or your own MinIO](#using-s3-r2-or-your-own-minio). |

Put each setting in the file listed here: the compose file sets the `.env` ones for the app itself, so the same line in `app.env` would be ignored. Every setting is listed in the [configuration reference](/docs/configuration).

## 2. Start it

```sh
docker compose up -d
```

The first start pulls the images. The app listens on port 8080 (or `ARTIFACT_PORT`). It creates and updates its database tables on every start. Open `APP_URL` and create the first account: it becomes the instance admin (see [The instance admin](#the-instance-admin)). Without email, the first page you see is **Set up this server**, which asks for your email and a password. Do this before you share the address.

The image includes a headless Chromium for gallery thumbnails. The compose file runs the app with `deploy/seccomp-chromium.json` so Chromium can keep its sandbox on (see [Security](/docs/security)); keep that line if you write your own compose file, or the log will say thumbnails are off. On Kubernetes the profile goes on the nodes; see [Kubernetes](/docs/kubernetes#3-the-seccomp-profile).

## Where content is stored

Postgres holds accounts, organizations, sharing and the list of versions. The content itself (every version's HTML, its files and its thumbnail) is in object storage, one object per distinct content under `blobs/<sha256>`. Versions that reuse a stylesheet or image, and restored versions, store nothing new. When pages or accounts are deleted, their objects are removed by a sweep that runs every few hours; to run it now:

```sh
docker compose exec app node dist/scripts/sweep-storage.js
```

Back up both; see [Backup and restore](/docs/backups).

### Using S3, R2 or your own MinIO

Set these in `.env` (`.env.example` has blocks for AWS S3, R2 and others), then remove the `minio` service and the app's `depends_on: minio` from the compose file:

```sh
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # empty for AWS S3
S3_REGION=auto
S3_BUCKET=artifact
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

The bucket should be private: pages are always served through the app, which checks access and adds the sandbox headers. Every setting is in the [configuration reference](/docs/configuration#object-storage).

## 3. Put it behind HTTPS

Agents and browsers should reach The Artifact over HTTPS. Any reverse proxy works. With Caddy:

```
artifact.example.com {
  reverse_proxy localhost:8080
}
```

Then set `APP_URL=https://artifact.example.com` and `TRUST_PROXY=true` in `app.env`, and restart with `docker compose up -d`. `TRUST_PROXY` tells the app to take each visitor's address from the `X-Forwarded-For` header the proxy adds; without it, every visitor has the proxy's address, and the [per-network rate limits](/docs/configuration#rate-limits) count them all together. Only set it when the app can't be reached except through the proxy, or anyone could claim any address.

## 4. Connect agents

Each person adds the MCP server once, using `APP_URL` followed by `/mcp`:

```sh
claude mcp add --transport http --scope user the-artifact https://artifact.example.com/mcp
```

See [Connect your agent](/docs/connect-your-agent) for Cursor, Codex and other MCP clients.

## The instance admin

The first account created on a fresh install becomes its admin. Only one account can be first: if two people sign up at the same moment, exactly one of them gets it. After signing up, the admin is asked to name the organization everyone on the server works in (or to skip it and start on their own). Everyone who signs up after that is a regular user until an admin promotes them: they start in their personal workspace with nothing to choose, and join organizations by invitation.

Admins see **Server admin** in the menu under their name, which opens `/admin`:

- **Overview**: how many people, organizations and pages the install has, and who has been active this week.
- **People**: search everyone by name or email and see their organizations, page count and when they were last seen. From there you can:
  - **Make admin** or **Remove admin**. The last admin can't be removed.
  - **Suspend** someone. They are signed out everywhere, their connected agents stop working, and they can't sign in again until you unsuspend them. Their pages stay where they are, and links to them keep working.
  - **Delete** an account, with the same rules as deleting your own in Account settings: organizations with nobody else in them go with it, and someone who is the only owner of an organization with other members can't be deleted until another owner is chosen or the organization is deleted.
- **Organizations**: every organization with its owners, member and page counts. Deleting one removes its pages, memberships and invitations; the people keep their accounts.
- **Sign-up**: who can create an account, and an optional instance name shown next to the logo.

### Sign-up policy

| Policy | Who can create an account |
| --- | --- |
| Anyone | Anyone who can reach the server |
| Email domains | Addresses at the domains you list |
| Invited people only | Nobody on their own |

In every mode, people invited to an organization or a page can still create an account to accept the invitation, and existing accounts can always sign in. Until an admin saves this form, anyone can sign up.

### An existing install without an admin

Installs created before instance admins existed, or ones whose admins have all left, have accounts but nobody to promote others. Make an existing account an admin from the server:

```sh
docker compose exec app node dist/scripts/make-admin.js you@example.com
```

It also restores the account if it was suspended. On a server without email it prints a link that sets a new password, so it doubles as the way back in when the only admin forgot theirs. It needs a shell on the server, so it gives nobody more access than they already have.

The automatic first-account admin applies unless `SELF_HOSTED=false`, which only the hosted service sets.

## Running without email

Leave `SMTP_HOST` empty and The Artifact sends no email:

- **First start**: the web app shows **Set up this server**. The account you create there, with a password, is the instance admin.
- **Logging in**: with email and password, or with Google when it is configured.
- **Signing up on their own**: under the **Anyone** or **Email domains** policy, the sign-up page asks for an email and a password. Nobody checks that the address belongs to the person typing it, so an address someone invited or shared a page with can't be taken there; that person uses their invitation link or a sign-up link. If people you don't trust can reach the server, choose **Invited people only**.
- **Adding people**: under **Server admin**, **People**, enter their address and choose **Make sign-up link**. Send them the link however you like; it works once, for 7 days, and asks them to choose a password. It creates their account whatever the sign-up policy says.
- **Organization invitations**: inviting someone gives you the invitation link to pass on. Someone without an account creates one from that page with a password.
- **Forgotten passwords**: an admin opens the person under **People** and chooses **Password reset link**. Using it signs them out everywhere else.
- **Sharing pages**: people are added without an email; send them the page link.
- **Comments**: nobody is emailed about new ones. They show as new on gallery cards and on the page's **Comments** button.

Anyone can change or set their password under **Account settings**, **Password**. Wrong passwords are limited to 10 per address every 15 minutes. Add SMTP later and sign-in links work as usual; existing passwords keep working too.

## Google sign-in (optional)

In Google Cloud Console, create an OAuth client of type Web application. Add `APP_URL` as an authorized JavaScript origin and `APP_URL/api/auth/google/callback` as the redirect URI, then put the client ID and secret in `app.env` and restart.

## Updating

Set `ARTIFACT_VERSION` in `.env` to the new release, then get the matching compose file and start it:

```sh
git pull
docker compose up -d
```

`docker compose up -d` pulls the new image and restarts the app with it; your data stays in its volumes. Database changes apply automatically when the new version starts, and an older version may not run on them, so take a [backup](/docs/backups) first. Pages published before thumbnails existed get theirs the first time the gallery lists them; to render them all at once:

```sh
docker compose exec app node dist/scripts/backfill-thumbnails.js
```

### Building the image yourself

To run your own changes, or a commit that isn't released yet, build the image from the checkout. Add this line to `.env`, so every `docker compose` command also reads `docker-compose.build.yml`:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml
```

Then build and start, and do the same after every `git pull`:

```sh
docker compose up -d --build
```

The build is tagged `the-artifact:local`, and `ARTIFACT_VERSION` is ignored. Remove the line from `.env` to go back to the published image. The project and its volumes are the same either way, so your data stays.

### Installs that built the image before

The compose file of 0.1.0 and earlier built the image on your server. After `git pull` it runs the published image instead, with the same project name and volumes, so your data stays. Start it once, then remove the old build:

```sh
git pull
docker compose up -d
docker image rm the-artifact:latest
```

To keep building from the checkout, see [Building the image yourself](#building-the-image-yourself).

### Installs from before `deploy/docker-compose`

The compose file used to be `docker-compose.selfhost.yml` at the root of the repository, with `.env.selfhost` next to it. After `git pull`, stop the old one, move your settings, and start from the new folder:

```sh
docker compose -f docker-compose.selfhost.yml down   # before git pull, or from an older checkout
git pull
mv .env.selfhost deploy/docker-compose/app.env
mv .env deploy/docker-compose/.env                   # if you have one
cd deploy/docker-compose
docker compose up -d
```

Your data stays: the compose file keeps the project name `the-artifact`, so it finds the same volumes. If you cloned into a folder with another name, set `name:` at the top of `docker-compose.yml` to that folder's name first (`docker volume ls` shows it before `_artifact-data`).

## Health checks and metrics

The app answers two probes on its own port, without signing in:

| Path | Answers `200` when | Otherwise |
| --- | --- | --- |
| `/healthz` | The process is running and answering requests | No answer |
| `/readyz` | Postgres and object storage both answer within 2 seconds | `503`, with which of them failed |

Both return JSON, e.g. `{"status":"ok","checks":{"database":"ok","storage":"ok"}}` from `/readyz`. The reason a check failed goes to the app's log, not into the response. The compose file uses `/readyz` as the app's healthcheck, so `docker compose ps` shows the app as `healthy` once it can serve pages. On Kubernetes, `/healthz` is the startup and liveness probe and `/readyz` the readiness probe, so a database outage takes the pod out of the service without restarting it.

### Logs

The app logs one JSON object per line: one per request, with `requestId`, `method`, `route`, `status` and `durationMs`, and others for things like failed emails or thumbnails. `route` is the pattern that matched (`/api/artifacts/:slug`), never the address itself, so page links and tokens stay out of the log. Every response has an `X-Request-Id` header with the request's id. When your reverse proxy sends its own `X-Request-Id` (letters, digits, `.`, `_`, `:` and `-`, up to 128 characters), the app uses that instead, so you can follow one request through both logs. Probes and scrapes that succeed aren't logged.

```sh
docker compose logs app | grep '"status":5'
```

### Scraping the metrics

Metrics are off until you set `METRICS_TOKEN`. Choose a long random value, put it in `app.env` and restart:

```sh
echo "METRICS_TOKEN=$(openssl rand -hex 32)" >> app.env
docker compose up -d
```

`GET /metrics` then returns metrics in the Prometheus text format to requests that send the token as a bearer token. Without the token, or with a wrong one, it answers `404` like any unknown address. The token is checked by the app rather than by keeping the metrics on a separate port, because the compose file and the Kubernetes manifests publish a single port, and every Prometheus-compatible scraper can send a bearer token. Anyone who can reach `APP_URL` can also reach `/metrics`, so keep the token secret; your reverse proxy can block `/metrics` from outside as well.

A Prometheus scrape job:

```yaml
scrape_configs:
  - job_name: the-artifact
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/the-artifact-token
    static_configs:
      - targets: ['artifact.example.com']
```

On Kubernetes, scrape the service inside the cluster (`the-artifact.the-artifact.svc:80`, scheme `http`) instead of going through the ingress.

| Metric | Type | What it measures |
| --- | --- | --- |
| `artifact_http_request_duration_seconds` | histogram | Requests by `method`, `route` (the matched pattern) and `status` |
| `artifact_db_pool_max` | gauge | Connections the database pool may open (10) |
| `artifact_db_pool_active` | gauge | Queries and transactions holding or waiting for a database connection. Above `artifact_db_pool_max`, requests are queueing for the database. |
| `artifact_s3_request_duration_seconds` | histogram | Object storage requests by `operation` (`GetObject`, `PutObject`, ...) and `outcome` (`ok`, `not_found`, `error`), retries included |
| `artifact_thumbnail_queue_length` | gauge | Versions waiting for a thumbnail or being rendered |
| `artifact_thumbnail_render_duration_seconds` | histogram | Thumbnail renders by `outcome` (`stored`, `failed`) |
| `artifact_process_*`, `artifact_nodejs_*` | various | CPU, memory, event loop lag and garbage collection of the Node.js process |

The numbers are per process and start from zero when the app restarts, which Prometheus handles on its own.

## Backups

Back up the database and the content storage together; [Backup and restore](/docs/backups) has the commands and how to restore onto a new server.
