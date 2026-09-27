# deploy/

Self-hosting manifests. Operators follow `docs/self-hosting.md` (Compose) and `docs/kubernetes.md`, so any change here needs the matching doc change. The repo-root `docker-compose.yml` is for development only.

- `docker-compose/` — app + Postgres + MinIO. `app.env` holds the app's settings; `.env` holds what Compose itself reads (port, passwords, `S3_*`). The project `name: the-artifact` is kept so installs that moved here from the repo root keep their volumes; don't rename it or the volumes.
- `kubernetes/` — Kustomize base (`kubectl apply -k deploy/kubernetes`). Every setting goes into one Secret generated from `app.env`. `patches/thumbnails-off.yaml` is for clusters that can't install the seccomp profile.
- `seccomp-chromium.json` — Docker's default seccomp profile plus the namespace calls Chromium's sandbox needs for thumbnails of untrusted pages. Used by both setups; don't replace it with `unconfined` or turn the Chromium sandbox off.

When a setting is added or changed in `apps/api/src/env.ts`, update the `*.env.example` files here if operators are expected to set it, and `docs/configuration.md` either way. Only `.example` files are committed; real `.env`/`app.env` files are ignored by the `.gitignore` in each folder.
