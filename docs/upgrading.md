# Upgrading

Each release of The Artifact has a version number, a list of changes and, when something needs you to act, upgrade notes. This page says what the version number tells you, how to move a self-hosted server to a new release, and what to do for each release that needs more than a restart.

## Where releases are listed

Releases are at https://github.com/andidev30/the-artifact/releases, and the same list is in `CHANGELOG.md` in the repository. Each release lists its features and fixes, then **⚠ BREAKING CHANGES** when there are any, then **Upgrading** when you have to do something. The upgrade notes are also below, under [Upgrading to a release](#upgrading-to-a-release).

## New releases

On a self-hosted server, **Server admin** shows a notice when a newer release than the one running is out, with a link to its release notes. Pre-releases are left out. To find out, the server asks GitHub's public releases API (`api.github.com/repos/andidev30/the-artifact/releases`) at most once a day, and only when an admin opens **Server admin**. The request carries nothing about your server: no address, no counts, no identifier. If GitHub can't be reached, the notice doesn't show and the server tries again the next day.

To turn the check off, for example on a server without internet access, set `RELEASE_CHECK=false` in `app.env` (`releaseCheck: false` in Helm values) and restart. The server then makes no request at all. See the [configuration reference](/docs/configuration).

## Version numbers

Versions are `major.minor.patch`, e.g. `1.4.2`:

| Release | What changes | What you do |
| --- | --- | --- |
| Patch (`1.4.2` to `1.4.3`) | Fixes and performance improvements only | Update. Nothing to read first. |
| Minor (`1.4.3` to `1.5.0`) | New features, and fixes | Read the release notes. Existing settings, pages and agents keep working. |
| Major (`1.5.0` to `2.0.0`) | Something that can break an install | Read the **⚠ BREAKING CHANGES** and **Upgrading** sections and do what they say before you start the new version. |

Before 1.0.0, a minor release takes the place of a major one: `0.4.0` to `0.5.0` can include breaking changes, and a patch (`0.5.0` to `0.5.1`) is fixes only. Every breaking change is listed under **⚠ BREAKING CHANGES** in the release notes either way.

### What counts as breaking

A change is breaking when a server or an agent that worked before can stop working, or behave differently, after you update without changing anything. That includes:

| Area | Breaking |
| --- | --- |
| Settings | An environment variable removed or renamed, a new one that must be set, or a changed default (see the [configuration reference](/docs/configuration)) |
| Database | A migration that the previous version can't run on, so going back means restoring a backup rather than starting the older image |
| Agents | An MCP tool removed or renamed, an argument removed, renamed or made required, or a result that changes shape (see [Publishing pages](/docs/publishing)) |
| API | A route under `/api` removed or changed in a way that breaks existing callers |
| Deploy files | A change to `deploy/docker-compose` or `deploy/kubernetes` that needs you to edit your own copy, move a file or change a volume, or a Helm value removed, renamed or with a changed default |
| Requirements | A newer Postgres, Kubernetes or Docker Compose than before |

New settings with a default, new MCP tools and new optional arguments are not breaking. Database changes that only add tables or columns are not breaking either, but they still apply on start, so read [Going back to an older release](#going-back-to-an-older-release).

## Image tags

The image is `ghcr.io/andidev30/the-artifact`, for `linux/amd64` and `linux/arm64`:

| Tag | Points at |
| --- | --- |
| `0.2.0` | That release, and never changes |
| `0.2` | The newest patch of 0.2, so fixes arrive when you pull |
| `latest` | The newest release, whichever it is |
| `main` | The newest commit on `main`, released or not. For trying changes, not for servers people use. |
| a short commit hash | That commit on `main` |

Pin a server to a version: `0.2` to get fixes on every pull, or an exact version to decide when each one arrives. Don't run `latest` on a server: it moves to a new minor or major release on the next pull, before you have read its notes.

## Before you upgrade

1. Read the release notes of every release between yours and the new one, and the upgrade notes below for each of them. Your version is `ARTIFACT_VERSION` in `.env` (Docker Compose), the chart version `helm list -n the-artifact` shows (Helm) or `newTag` in `kustomization.yaml` (Kubernetes manifests).
2. Take a backup of the database and the content storage; see [Backup and restore](/docs/backups). Database changes apply when the new version starts.
3. Do what the **Upgrading** sections say, in order, oldest release first.

You can skip releases: going from `0.2.0` straight to `0.6.0` applies every database change in between on the first start.

## Docker Compose

From `deploy/docker-compose`, get the compose file of the new release, set the version and start it:

```sh
git fetch --tags
git checkout v0.2.0
# In .env, set ARTIFACT_VERSION=0.2.0 (or 0.2)
docker compose up -d
```

`docker compose up -d` pulls the image and restarts the app with it. Your data stays in its volumes. When you pin a major.minor like `0.2`, get its newest patch with `docker compose pull && docker compose up -d`. See [Updating](/docs/self-hosting#updating) for thumbnails of old pages and for installs that built the image themselves.

## Helm

The chart is published with every release, under the same version, and runs that release's image. Upgrade to the new version with the values you installed with:

```sh
helm upgrade the-artifact oci://ghcr.io/andidev30/charts/the-artifact --version 0.2.0 \
  --namespace the-artifact -f values.yaml
kubectl -n the-artifact rollout status deploy/the-artifact
```

Upgrade notes that change values say so. See [Upgrading a Helm install](/docs/kubernetes#upgrading-a-helm-install).

## Kubernetes

Get the manifests of the new release, set `newTag` under `images` in `deploy/kubernetes/kustomization.yaml` if you changed it, and apply:

```sh
git fetch --tags
git checkout v0.2.0
kubectl apply -k deploy/kubernetes
kubectl -n the-artifact rollout status deploy/the-artifact
```

A checkout of a release names that release in `kustomization.yaml`. Your `app.env` is not in the repository, so the checkout leaves it alone; compare it with `app.env.example` for settings the release notes ask you to add. See [Updating](/docs/kubernetes#updating) for your own builds.

## Going back to an older release

A patch release doesn't change the database in a way the previous patch can't run on, so you can go back to it by setting the older version and starting it again.

Across minor and major releases, the newer version may have changed the database in a way the older one can't run on. To go back, stop the app, restore the backup you took before upgrading (see [Restore](/docs/backups#restore)), and start the older version. Pages published and changes made since the backup are lost.

## Upgrading to a release

Only releases that need you to do something are listed. Each section is copied into the **Upgrading** part of its release notes.

## Upgrading to 0.2.0

- **Docker Compose runs the published image.** The compose file of 0.1.0 built the image on your server as `the-artifact:latest`. After you check out 0.2.0 and start it, remove the old build with `docker image rm the-artifact:latest`. See [Installs that built the image before](/docs/self-hosting#installs-that-built-the-image-before).
- **Rate limits count visitors by network.** Behind a reverse proxy, set `TRUST_PROXY=true` in `app.env`, or every visitor has the proxy's address and shares one limit. On Kubernetes, add `TRUST_PROXY=true` to your `app.env`; the new `app.env.example` has it. See [Put it behind HTTPS](/docs/self-hosting#3-put-it-behind-https).
- **Kubernetes pins the image.** `kustomization.yaml` used to run `latest`; it now names the release. If you kept `newTag: latest`, set it to `'0.2'` or `'0.2.0'`.
- **The database gains tables** for rate limits, folders, comments, access tokens, passkeys and two-factor sign-in, and columns for requiring two-factor sign-in in an organization and for listing active sessions. They are added on the first start, so take a backup before it; see [Before you upgrade](#before-you-upgrade).

## Upgrading to 0.3.0

- **Take a backup first.** The database gains tables and columns for license keys, the release check, page views, link sharing options, version retention, the audit log, single sign-on and SCIM. They are added on the first start and nothing existing changes, so 0.2.0 still runs on the new schema if you have to roll back. See [Before you upgrade](#before-you-upgrade).
- **The admin area tells you about new releases.** Once a day, when an admin opens **Server admin**, the server asks GitHub's public releases API for the newest release; nothing about your server is sent. On a server without internet access, or if you don't want the request, set `RELEASE_CHECK=false` in `app.env` (`releaseCheck: false` in Helm values). See [New releases](#new-releases).
- **Consider a separate domain for pages** on a server reachable from the internet. With `CONTENT_ORIGIN` set, pages load from a second address, so a page that escaped its sandbox still couldn't reach your sign-in cookies. It needs a second DNS name and certificate pointing at the same server, and your proxy must pass the original `Host`. Nothing changes if you leave it empty. See [A separate domain for pages](/docs/self-hosting#a-separate-domain-for-pages).
- **Enterprise features need a license key.** Single sign-on (OpenID Connect and SAML), SCIM provisioning, the audit log and version retention are off until an instance admin enters a key under **Server admin** → **License**. Everything that 0.2.0 did stays free and needs no key. The key is checked on your server; nothing is sent anywhere. See [Licenses](/docs/licenses). The terms for the code in `ee/` changed with this: read `LICENSE-EE` if you modify or redistribute it.
- **New optional settings:** `AUDIT_LOG_RETENTION_DAYS` (default 365). `LICENSE_SIGNING_KEY` is for the hosted service only; leave it unset. See [Configuration](/docs/configuration).
- **Page entry files are revalidated on every open.** To count views, a page's main HTML file is now sent with `Cache-Control: private, no-cache` instead of an hour of caching. Unchanged pages answer with a short 304, and the page's other files keep their cache, but a busy server sees more requests for entry files.

## Upgrading to 0.5.0

- **A SCIM token for an organization reaches only that organization's members.** It no longer lists or changes other accounts, and it suspends or changes the email address only of members who are in no other organization and aren't instance admins; deactivating anyone else removes them from the organization. If your IdP uses a token for an organization to manage people who aren't in it, invite them to the organization, or make a token for every account under **Server admin** → **Provisioning (SCIM)**. See [What a token for an organization reaches](/docs/scim#what-a-token-for-an-organization-reaches).
- **Organizations that require two-factor sign-in now also refuse agents and access tokens** of members who haven't set up a second factor. Before you upgrade, check the **Members** list of such organizations for people whose CI publishes there without **2FA on**. See [Requiring two-factor sign-in](/docs/organizations#requiring-two-factor-sign-in).
- **The Docker image starts one worker process per CPU**, up to 8, instead of one process, so a server with several cores serves more. Each worker takes about 250 MB of memory. With Docker Compose on a server with little memory, or one that runs other things, set `WEB_CONCURRENCY` in `app.env` (`1` keeps a single process). The Helm chart keeps one process unless you give the pod a CPU limit or set `webConcurrency`. The plain Kubernetes manifests keep one process until you change `WEB_CONCURRENCY` in `app.yaml`, which wins over a value in `app.env`; see [Using more cores](/docs/kubernetes#using-more-cores). Each worker has its own database pool; with the defaults the server opens about 20 connections at most, 10 with one worker (`DATABASE_POOL_MAX`). See [More than one worker](/docs/configuration#more-than-one-worker).
- **Changes from a browser session must come from the app itself.** Requests that change something and are signed in with the session cookie are refused with 403 unless the browser says they come from this server's address (`Origin` or `Sec-Fetch-Site`). The web app, agents, the CLI and anything using an access token or `Authorization: Bearer` are unaffected. A script of your own that posts to `/api` with a copied session cookie has to send `Origin: <APP_URL>`, or use an [access token](/docs/security#access-tokens) instead.
- **Adding a first password or a second factor asks you to sign in again** if you signed in a while ago, the same as changing a password already did.
- **New email addresses are checked more strictly** (no quotes, angle brackets, spaces or similar). Existing accounts keep signing in with the address they have.
- **Two thumbnails render at a time** by default (`THUMBNAIL_CONCURRENCY`), so a server with thumbnails on uses a little more memory while rendering. Set it to `1` for the old behaviour.
- **The app loads its fonts from your server**, no longer from Google, and a self-hosted install answers `/robots.txt` with `Disallow: /` for everything except link previews.
- **The database gains two columns**, for refresh token reuse detection and for accounts whose address was never confirmed by email. They are added on the first start, and 0.4.0 still runs on the new schema.

## Upgrading to 0.6.0

- **The database gains tables** for [data exports](/docs/exporting-your-data), [webhooks](/docs/webhooks) and their deliveries, and a column for [comments pinned to an element](/docs/comments). They are added on the first start, and 0.5.0 still runs on the new schema.
- **Data exports are built in your bucket** under `exports/`, and the storage sweep deletes them after their link expires. Nothing to configure; with `S3_PUBLIC_ENDPOINT` set, downloads go straight from the bucket.
- **The server may make outbound HTTPS requests** to the webhook addresses your workspace admins add, from the first worker. If your firewall limits outbound traffic, allow the destinations you want (such as `hooks.slack.com` or `discord.com`). Requests to private and reserved addresses are always refused; see [Webhooks can't reach private networks](/docs/security#webhooks-cant-reach-private-networks).
- **On hosts without a long-running server** (Vercel), webhook retries run with `GET /api/cron/sweep`, or more often with the new `GET /api/cron/webhooks`; schedule it every few minutes if your host allows. See `CRON_SECRET` in the [configuration reference](/docs/configuration).
- **Search looks inside pages, and pages have tags.** The database gains a table for tags and one for the words of each page's current version, with a full-text index. They are added on the first start and nothing existing changes, so 0.5.0 still runs on the new schema. Take a backup first; see [Before you upgrade](#before-you-upgrade).
- **Index the pages you already have.** New versions are indexed as they are published. Pages from before the upgrade are indexed by the storage sweep a few hundred at a time (every few hours, or on each `/api/cron/sweep`); to have search find all of them right away, run once after the upgrade:
  - Docker Compose: `docker compose exec app node dist/scripts/backfill-search.js`
  - Kubernetes: `kubectl -n the-artifact exec deploy/the-artifact -c app -- node dist/scripts/backfill-search.js`
  - From a checkout: `pnpm --filter @the-artifact/api search:backfill`

  It reads each page's HTML from object storage, so it takes a while on a large server; the app keeps serving meanwhile, and running it again picks up where it stopped. See [Search](/docs/publishing#search).

## Upgrading to 1.0.0

- **Single sign-on no longer links some existing accounts.** The first sign-in through a provider never takes over an instance admin's account, and a provider that lists no email domains links an existing account only when it marked the address as verified itself or created the account over SCIM. People with an account who haven't signed in through such a provider yet (a [SAML](/docs/saml) provider, or an OIDC one with **Trust addresses**) now see a message to sign in the way they did before. If they should use single sign-on, list the provider's email domains under **Server admin** → **Single sign-on**; accounts already linked keep working. See [Linking existing accounts](/docs/sso#linking-existing-accounts).
- **Keep the server log if you need a record of what admins do.** Admin actions, deleted accounts and organizations, and changes to people's sign-in are written to it as JSON lines with an `event` field; there is no instance-level audit log in the app. See [The security log](/docs/security#the-security-log).
- **Requests are limited to 1 MB**, except publishing (`POST /api/publish` and MCP, which keep their limits) and the single sign-on settings (3 MB). Larger requests are refused with `413`. See [Limits](/docs/configuration#limits).
- **Single sign-on no longer follows redirects or reaches loopback and link-local addresses.** If a SAML provider's metadata URL redirects, enter the address it redirects to. An identity provider on the same machine as the server (`localhost`) is refused unless `APP_URL` is `http://`; use its address on your network instead. See [Requests to identity providers](/docs/security#requests-to-identity-providers).
- **Shares need a checked address.** On a server without email, a page shared with an address no longer opens for an account whose address nobody checked (signed up with a password, or made from an invitation link) until that account opens the share's own link, which **Share** now lists for everyone who wasn't emailed. People who already rely on such shares lose them until they open a new link: share with them again and send the link, or give them an admin's sign-in link (**Server admin** → **People**), which checks the address. See [Addresses nobody has checked](/docs/sharing#addresses-nobody-has-checked).
- **Proving an address takes over an unverified account.** The first sign-in with an email link, an admin's sign-in link, Google or single sign-on to such an account removes its password, sessions, agents, access tokens, passkeys, authenticator app, recovery codes and personal webhooks. Tell people on a server without email who later sign in with Google or get SMTP turned on. See [Unverified accounts](/docs/security#unverified-accounts).
- **The database gains two columns** on `artifact_shares`, for the share's link and the account that opened it. They are added on the first start, and 0.6.x still runs on the new schema.
- **New rate limits** `invite-recipient` (10 invitation and share emails per address per day) and `unshare` (200 people removed per hour per account), and `invite` now counts shares made without an email too. Change them with `RATE_LIMITS` if they get in your way; see [Rate limits](/docs/configuration#rate-limits).
- **Creating an access token needs a sign-in from the last hour**, like adding a second factor. Scripts that create tokens with a copied session cookie need a fresh one.
- **Agents and access tokens act on pages only in their own workspace.** Owning a page, or a role in an organization, now counts only for pages in the workspace the agent or token was connected to; elsewhere it reaches only pages shared with the person directly or by link. A CI job or agent connected to a personal workspace that updates, shares or deletes an organization's pages (or the other way round) is refused with "No page you can edit". Make an access token for that organization, or connect the agent to it, before you upgrade. See [Choosing a workspace](/docs/connect-your-agent#choosing-a-workspace).
- **Owning a page in an organization counts only while you are a member.** People who left or were removed from an organization, or are kept out of it by its two-factor requirement, can no longer open, change, share, delete or export the pages they published there unless those are shared with them. The organization's owners and admins keep editing them.
- **Direct uploads have a limit of their own.** `prepare_upload` counts the size of the files it hands out links for toward the new `upload` rate limit, 2048 MB per account per hour. Raise it with `RATE_LIMITS=upload=<n>/1h` if your agents upload more. See [Rate limits](/docs/configuration#rate-limits).
- **Set an encryption key.** The keys the server keeps in its database (for authenticator apps, webhooks, single sign-on and page links) can now be stored encrypted with `ENCRYPTION_KEY`, so a copy of the database or a backup alone doesn't give them away. Make one with `openssl rand -base64 32`, put it in `app.env` (`encryptionKey` in Helm values, or `ENCRYPTION_KEY` in your `existingSecret`), and restart once every server of the install runs 1.0.0. The server encrypts the existing rows as it starts; people keep their authenticator apps and nothing else changes. Keep the key apart from your backups: from then on the server needs it to start. Without it, everything works as before. See [Encryption key](/docs/configuration#encryption-key).
