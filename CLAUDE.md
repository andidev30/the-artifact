# The Artifact

Hosts the HTML pages coding agents build. An agent publishes through the MCP server at `/mcp`, gets a link back, and the person chooses who can open it. Free to self-host (one Docker image + Postgres + S3-compatible storage); there is also a hosted service.

## Layout

| Path | What | Notes |
| --- | --- | --- |
| `apps/api` | Hono API, MCP server, OAuth 2.1 server, thumbnail renderer | see `apps/api/CLAUDE.md` |
| `apps/web` | React 19 + Vite single-page app, including the in-app docs | see `apps/web/CLAUDE.md` |
| `docs/` | User and operator docs, rendered at `/docs` and read on GitHub | see `docs/CLAUDE.md` |
| `deploy/` | Docker Compose and Kubernetes manifests for self-hosting | see `deploy/CLAUDE.md` |
| `apps/*/src/ee/` | Hosted-service-only code (marketing, contact sales, workspace choice), under `LICENSE-EE` | see `apps/*/src/ee/CLAUDE.md` |
| `e2e/` | Playwright specs | setup in `TESTING.md` |
| `docker-compose.yml` | Dev services only: Postgres, MinIO, Mailpit | not for deploying |
| `Dockerfile` | Production image: API + built web app on one port | |

## Commands

```sh
pnpm install
pnpm services                  # Postgres :5432, MinIO :9000/:9001, Mailpit :1025/:8025
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm dev                       # API :3000, web :5173 (proxies /api, /mcp, /oauth, /.well-known)

pnpm lint                      # Biome (lint + format check) + tsc over the API, its tests and the web app
pnpm format                    # Biome: format and apply safe fixes
pnpm test                      # unit + integration; integration needs `pnpm services` and the artifact_test db
pnpm test:e2e                  # Playwright on ports 3004/5177, needs Google Chrome and Mailpit
pnpm db:generate               # new migration from apps/api/src/db/schema.ts
```

Create the test database once: `docker compose exec postgres createdb -U artifact artifact_test`. Details in `TESTING.md`.

## Modes every change has to work in

- **Self-hosted vs hosted.** `SELF_HOSTED` is on unless set to `false`. Self-hosted skips the marketing pages; its first account becomes the instance admin and names the server's organization, and everyone after it starts in a personal workspace and joins organizations by invitation. On the hosted service everyone chooses **Just me** or **My team**. Only the hosted service sets `false`.
- **With vs without email.** Without `SMTP_HOST` nothing is emailed: people sign in with a password, and admins and inviters pass links on by hand. Sign-in, invitations and sharing all have both paths; `apps/api/test/integration/no-email.test.ts` covers the no-email one.
- **Thumbnails on vs off.** Without `CHROME_PATH` there are no screenshots and cards show a drawn sketch.

## Licensing

Everything is AGPL-3.0 (`LICENSE`) except folders named `ee/`, which are under `LICENSE-EE`. Hosted-service-only features go in `ee/`; anything a self-hosted install uses stays outside it. Don't copy code from `ee/` into core.

## Conventions

- Node 26, TypeScript 7, ESM. Biome (`biome.json`) formats and lints everything: no semicolons, single quotes, 2-space indent, 160 columns. Run `pnpm format` before committing; `pnpm lint` fails on unformatted code.
- Silence a Biome rule only at the line, with `// biome-ignore <rule>: <why>`; the reason is required.
- The API imports local files with a `.js` suffix; the web app imports without one (`.tsx` in `main.tsx`).
- Comments say why, or state a rule that isn't visible in the code (security, races, compatibility). Don't add comments that restate the code, section labels, or change logs.
- Product copy says "page", not "artifact"; "artifact" is the internal name (tables, MCP tool names, URLs under `/api/artifacts`). Copy is plain, short sentences, no exclamation marks.
- Errors from the API are `{ error: string, field?: string }` with a 4xx status; the message is shown to people as is, so write it for them.
- Missing and no-access look the same (404) so private pages and organizations don't reveal they exist.
- Commits: conventional style with an optional scope, e.g. `feat: …`, `fix(web): …`, `refactor(api): …`, `docs: …`.

## When behaviour changes

- User-visible behaviour → update the matching page in `docs/`. It ships inside the app, so stale docs are a bug.
- New or changed env var → `apps/api/src/env.ts`, `docs/configuration.md`, `apps/api/.env.example`, and the examples in `deploy/` when operators need it.
- MCP tools or their arguments → `apps/api/src/mcp.ts` and the tool tables in `docs/publishing.md`.
- Schema → `pnpm db:generate` and commit the SQL and the snapshot together (see `apps/api/CLAUDE.md`).
- Finish with `pnpm lint` and the relevant tests; UI flows that cross the API also have e2e specs.
