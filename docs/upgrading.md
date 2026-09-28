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

You can skip releases: going from `0.2.0` straight to `0.5.1` applies every database change in between on the first start.

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

- **The admin area tells you about new releases.** Once a day, when an admin opens **Server admin**, the server asks GitHub's public releases API for the newest release; nothing about your server is sent. On a server without internet access, or if you don't want the request, set `RELEASE_CHECK=false` in `app.env` (`releaseCheck: false` in Helm values). See [New releases](#new-releases).
- **The database gains a table** (`release_check`) that remembers the last check. It is added on the first start.
