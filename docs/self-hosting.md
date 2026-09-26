# Self-hosting

The Artifact runs as one Docker image next to a Postgres database and an S3-compatible object store. The compose file brings all three, with MinIO as the object store. It is free to self-host, with every feature included.

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
| `ALLOWED_EMAIL_DOMAINS` | Optional. Comma-separated domains that may create accounts, e.g. `example.com`. People from other domains can still join when they are invited to an organization or a page. Leave it empty to let anyone sign up. Once an admin saves a sign-up policy in the [admin area](#the-instance-admin), that policy is used instead. |
| `ADMIN_EMAILS` | Optional. Comma-separated addresses that are always instance admins. Use it to get into an install that has accounts but no admin. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Without them people sign in by email only. |

Every setting is listed in the [configuration reference](/docs/configuration).

## 2. Start it

```sh
docker compose -f docker-compose.selfhost.yml up -d
```

The app listens on port 8080 (change it with `ARTIFACT_PORT=9000`). It creates and updates its database tables on every start. Open `APP_URL` and create the first account: it becomes the instance admin (see [The instance admin](#the-instance-admin)). Do this before you share the address.

The image includes a headless Chromium for gallery thumbnails. The compose file runs the app with `docker/seccomp-chromium.json` so Chromium can keep its sandbox on (see [Security](/docs/security)); keep that line if you write your own compose file or Kubernetes manifest, or the log will say thumbnails are off.

The database and MinIO passwords default to `artifact` and `artifact-secret`, and neither service is reachable from outside the compose network. To change them, set `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` in a `.env` file next to `docker-compose.selfhost.yml` before the first start.

## Where content is stored

Postgres holds accounts, organizations, sharing and the list of versions. The content itself (every version's HTML, its files and its thumbnail) is in object storage, one object per distinct content under `blobs/<sha256>`. Versions that reuse a stylesheet or image, and restored versions, store nothing new. When pages or accounts are deleted, their objects are removed by a sweep that runs every few hours; to run it now:

```sh
docker compose -f docker-compose.selfhost.yml exec app node dist/scripts/sweep-storage.js
```

Back up both; see [Backup and restore](/docs/backups).

### Using S3, R2 or your own MinIO

Set these in the `.env` file next to `docker-compose.selfhost.yml`, then remove the `minio` service and the app's `depends_on: minio` from the compose file:

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

Then set `APP_URL=https://artifact.example.com` and restart with `docker compose -f docker-compose.selfhost.yml up -d`.

## 4. Connect agents

Each person adds the MCP server once, using `APP_URL` followed by `/mcp`:

```sh
claude mcp add --transport http --scope user the-artifact https://artifact.example.com/mcp
```

See [Connect your agent](/docs/connect-your-agent) for Cursor, Codex and other MCP clients.

## The instance admin

The first account created on a fresh install becomes its admin. Only one account can be first: if two people sign up at the same moment, exactly one of them gets it. Everyone who signs up after that is a regular user until an admin promotes them.

Admins see **Admin** in the header, which opens `/admin`:

- **Overview**: how many people, organizations and pages the install has, and who has been active this week.
- **People**: search everyone by name or email and see their organizations, page count and when they were last seen. From there you can:
  - **Make admin** or **Remove admin**. The last admin can't be removed.
  - **Suspend** someone. They are signed out everywhere, their connected agents stop working, and they can't sign in again until you unsuspend them. Their pages stay where they are, and links to them keep working.
  - **Delete** an account, with the same rules as deleting your own in Settings: organizations with nobody else in them go with it, and someone who is the only owner of an organization with other members can't be deleted until another owner is chosen or the organization is deleted.
- **Organizations**: every organization with its owners, member and page counts. Deleting one removes its pages, memberships and invitations; the people keep their accounts.
- **Sign-up**: who can create an account, and an optional instance name shown next to the logo.

### Sign-up policy

| Policy | Who can create an account |
| --- | --- |
| Anyone | Anyone who can reach the server |
| Email domains | Addresses at the domains you list |
| Invited people only | Nobody on their own |

In every mode, people invited to an organization or a page can still create an account to accept the invitation, addresses in `ADMIN_EMAILS` can always sign up, and existing accounts can always sign in.

Until an admin saves this form, the policy comes from `ALLOWED_EMAIL_DOMAINS` (anyone when it is empty). Once saved, the admin area's policy takes precedence; **Use the environment instead** forgets it and goes back to `ALLOWED_EMAIL_DOMAINS`.

### An existing install without an admin

Installs created before instance admins existed, or ones whose admins have all left, have accounts but nobody to promote others. Add your address to `ADMIN_EMAILS` in `.env.selfhost` and restart:

```sh
ADMIN_EMAILS=you@example.com
```

Addresses listed there are admins for as long as they are listed, even when they are suspended in the database or would otherwise be the last admin. Once you are in, you can make others admins from **People** and, if you like, remove your address from `ADMIN_EMAILS` after making yourself an admin there too. An admin granted by `ADMIN_EMAILS` can't be demoted or deleted from the admin area.

The automatic first-account admin applies whenever `SELF_HOSTED=true`, which the Docker image sets.

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

Back up the database and the content storage together; [Backup and restore](/docs/backups) has the commands and how to restore onto a new server.
