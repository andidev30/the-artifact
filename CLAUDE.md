# The Artifact

Hosts the HTML pages coding agents build. An agent publishes through the MCP server at `/mcp`, gets a link back, and the person chooses who can open it. Free to self-host (one Docker image + Postgres + S3-compatible storage); there is also a hosted service.

## Layout

| Path | What | Notes |
| --- | --- | --- |
| `apps/api` | Hono API, MCP server, OAuth 2.1 server, thumbnail renderer | see `apps/api/CLAUDE.md` |
| `apps/web` | React 19 + Vite single-page app, including the in-app docs | see `apps/web/CLAUDE.md` |
| `packages/cli` | `@the-artifact/cli` on npm: `publish`, `list`, `share`, `login` over `POST /api/publish`, `/mcp` and the OAuth server. No dependencies | versions on its own (`cli-vX.Y.Z`); its tests against a real server are in `apps/api/test/integration/cli.test.ts` |
| `docs/` | User and operator docs, rendered at `/docs` and read on GitHub | see `docs/CLAUDE.md` |
| `deploy/` | Docker Compose, Kubernetes manifests and the Helm chart for self-hosting | see `deploy/CLAUDE.md` |
| `apps/*/src/ee/` | Hosted-service-only code (marketing, contact sales, legal pages, onboarding welcome, Vercel analytics, the sign-up funnel, plan limits, issuing license keys) and enterprise features a license key unlocks on a self-hosted install, under `LICENSE-EE` | see `apps/*/src/ee/CLAUDE.md` |
| `ee/ops/` | Hosted-service operations: on-call runbook, backup and restore scripts run by `.github/workflows/hosted-*.yml` | see `ee/ops/runbook.md`; not in `docs/`, so it never ships in the app |
| `e2e/` | Playwright specs | setup in `TESTING.md` |
| `load/` | k6 load tests, a Compose file for a production-like server, metrics sampling | see `load/README.md`; seeding in `apps/api/test/load/seed.ts` |
| `docker-compose.yml` | Dev services only: Postgres, MinIO, Mailpit | not for deploying |
| `Dockerfile` | Production image: API + built web app on one port | |
| `release-please-config.json`, `CHANGELOG.md` | Releases: version, changelog and image tags, from conventional commits | see "Releases" in `CONTRIBUTING.md` |

## Commands

```sh
pnpm install
pnpm services                  # Postgres :5432, MinIO :9000/:9001, Mailpit :1025/:8025
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm dev                       # API :3000, web :5173 (proxies /api, /mcp, /oauth, /.well-known, /scim, /e/)

pnpm lint                      # Biome (lint + format check) + tsc over the API, its tests and the web app
pnpm format                    # Biome: format and apply safe fixes
pnpm test                      # unit + integration; integration needs `pnpm services` and the artifact_test db
pnpm test:e2e                  # Playwright: hosted on 3004/5177, self-hosted on 3005/5178; needs Google Chrome and Mailpit
pnpm db:generate               # new migration from apps/api/src/db/schema.ts
```

Create the test database once: `docker compose exec postgres createdb -U artifact artifact_test`. Details in `TESTING.md`.

## Modes every change has to work in

- **Self-hosted vs hosted.** `SELF_HOSTED` is on unless set to `false`. Self-hosted skips the marketing pages; its first account becomes the instance admin and names the server's organization, and everyone after it starts in a personal workspace and joins organizations by invitation. On the hosted service everyone starts in a personal workspace: new organizations are refused until the Organization plan has billing (#34, `apps/api/src/ee/plans.ts`), while existing ones, their members and invitations keep working. Only the hosted service sets `false`.
- **With vs without email.** Without `SMTP_HOST` nothing is emailed: people sign in with a password, and admins and inviters pass links on by hand. Sign-in, invitations and sharing all have both paths; `apps/api/test/integration/no-email.test.ts` covers the no-email one.
- **Thumbnails on vs off.** Without `CHROME_PATH` there are no screenshots and cards show a drawn sketch.

## Licensing

Everything is AGPL-3.0 (`LICENSE`) except folders named `ee/`, which are under `LICENSE-EE`, as in GitLab EE. `ee/` holds two kinds of code: hosted-service-only features, and enterprise features that a self-hosted install runs only with a valid license key. Everything a self-hosted install needs without a license stays outside `ee/`, and so does checking license keys (`apps/api/src/license.ts`), because every install runs it. Don't copy code from `ee/` into core.

An enterprise feature asks one gate, `hasEnterprise()` from `apps/api/src/license.ts` (or the `requireEnterprise` middleware on its routes), and does nothing without it. The gate is on while a self-hosted install's license is active and for 14 days after it expires; it is off on the hosted service until its Enterprise plan exists. Turning a feature off never deletes data. See `docs/licenses.md`.

## Conventions

- Node 26, TypeScript 7, ESM. Biome (`biome.json`) formats and lints everything: no semicolons, single quotes, 2-space indent, 160 columns. Run `pnpm format` before committing; `pnpm lint` fails on unformatted code.
- Silence a Biome rule only at the line, with `// biome-ignore <rule>: <why>`; the reason is required.
- The API imports local files with a `.js` suffix; the web app imports without one (`.tsx` in `main.tsx`); the CLI imports with `.ts` (rewritten to `.js` by `tsc`), so Node runs its sources directly in tests.
- Comments say why, or state a rule that isn't visible in the code (security, races, compatibility). Don't add comments that restate the code, section labels, or change logs.
- Product copy says "page", not "artifact"; "artifact" is the internal name (tables, MCP tool names, URLs under `/api/artifacts`). Copy is plain, short sentences, no exclamation marks.
- Errors from the API are `{ error: string, field?: string }` with a 4xx status; the message is shown to people as is, so write it for them.
- Missing and no-access look the same (404) so private pages and organizations don't reveal they exist.
- Commits: conventional style with an optional scope, e.g. `feat: …`, `fix(web): …`, `refactor(api): …`, `docs: …`. release-please turns them into the changelog and the next version (see "Releases" in `CONTRIBUTING.md`), so breaking changes get `!` and a `BREAKING CHANGE:` footer saying what operators must do.

## When behaviour changes

- User-visible behaviour → update the matching page in `docs/`. It ships inside the app, so stale docs are a bug.
- New or changed env var → `apps/api/src/env.ts`, `docs/configuration.md`, `apps/api/.env.example`, and the examples in `deploy/` when operators need it.
- MCP tools or their arguments → `apps/api/src/mcp.ts` and the tool tables in `docs/publishing.md`.
- Schema → `pnpm db:generate` and commit the SQL and the snapshot together (see `apps/api/CLAUDE.md`).
- Anything an operator must do on upgrade (a setting to add, a command to run, a deploy file to edit, a migration the previous version can't run on) → a `## Upgrading to x.y.z` section at the end of `docs/upgrading.md`; the Release workflow copies it into the GitHub release.
- New screen, dialog or menu → cover it with `expectAccessible` in `e2e/accessibility.spec.ts` (axe, WCAG 2.1 AA) and keep it usable with the keyboard alone (see `TESTING.md`).
- Finish with `pnpm lint` and the relevant tests; UI flows that cross the API also have e2e specs.
