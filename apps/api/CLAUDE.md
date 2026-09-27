# apps/api

Hono on Node 26, Drizzle ORM over `postgres`, S3 via `@aws-sdk/client-s3`, MCP via `@modelcontextprotocol/server`, thumbnails via `playwright-core` driving headless Chromium. Runs with `tsx watch` in dev, `tsc` → `dist/` in production.

## Where things are

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Boot: optional migrations (`MIGRATE_ON_START`), bucket check, storage sweeps, HTTP server |
| `src/app.ts` | Mounts every router; `GET /api/config` and `GET /api/me` |
| `src/env.ts` | Environment variables. Add new settings here and read them from `env` |
| `src/db/schema.ts` | Tables. `src/db/index.ts` exports `db`, `schema` and the `Tx` type |
| `src/artifacts.ts` | Pages and versions: access rules (`accessLevel`, `canView`, `canEdit`, `canDelete`), publish, restore, delete, listing (newest first, paged by an `(updated_at, id)` cursor) |
| `src/content.ts` | Serves a version as a document tree at `/api/artifacts/<slug>/v/<n>/…` and as a zip at `/api/artifacts/<slug>/download`, link tokens for sandboxed frames and agents' download links |
| `src/zip.ts` | Writes zip archives (no dependency) |
| `src/files.ts` | Multi-file page validation and size limits |
| `src/storage.ts`, `src/gc.ts` | Content-addressed blobs in S3 and the sweep that deletes unreferenced ones |
| `src/thumbnails.ts` | Gallery screenshots of untrusted HTML with no network of its own |
| `src/previews.ts` | Link preview (Open Graph) tags in the HTML shell of `/a/<slug>`, for link-shared pages only; mounted by `src/web.ts` and by `api/index.js` on Vercel |
| `src/folders.ts` | Folders of a workspace: who organizes them (`belongsTo`, `canFile`), names, filing pages. They never change access |
| `src/sharing.ts` | Per-person shares by email |
| `src/limits.ts` | Rate limits: counters in Postgres (`hit`, `limitRequest` for a 429 with `Retry-After`), `RATE_LIMITS` overrides, the client address (`clientIp`, `TRUST_PROXY`) |
| `src/quota.ts` | Pages, versions and storage per workspace, checked when a page or version is added; `WORKSPACE_MAX_*` and the plan hook for `ee/` |
| `src/instance.ts` | Instance admins, sign-up policy and instance settings |
| `src/mcp.ts` | The MCP tools (`publish_artifact`, `list_artifacts`, `list_folders`, `move_artifact`, `get_artifact`, `rename_artifact`, `set_artifact_visibility`, `share_artifact`, `delete_artifact`, `list_versions`, `restore_version`, `download_artifact`, and `prepare_upload`/`publish_upload` when `S3_PUBLIC_ENDPOINT` is set) |
| `src/uploads.ts` | Publishing by direct upload: upload links, then checking and claiming what arrived |
| `src/oauth/` | OAuth 2.1 server for MCP clients (discovery, dynamic registration, PKCE) and the consent API |
| `src/auth/` | Sessions, email links, passwords, Google sign-in, account lookup/creation |
| `src/routes/` | REST routers for the web app |
| `src/log.ts` | JSON logs, one object per line, tagged with the request id. Use `log.info/warn/error` rather than `console` |
| `src/metrics.ts`, `src/routes/health.ts` | Prometheus metrics and the per-request middleware (request id, log line, timing by route pattern); `/healthz`, `/readyz` and `/metrics` (only with `METRICS_TOKEN`) |
| `src/mail.ts` | Outgoing email. Throws `MailDisabledError` without SMTP |
| `src/ee/` | Hosted-service-only routes (contact sales); see `src/ee/CLAUDE.md` |
| `src/scripts/` | Operator CLIs (`admin:grant`, `storage:sweep`, `thumbnails:backfill`), also run as `node dist/scripts/*.js` in the image |

## Rules that aren't obvious from one file

- **Access.** Owners and invited editors edit; invited viewers view; organization admins and owners edit every page in their organization; general access (`private` shown as "Restricted", `organization`, `link`) opens a page wider. Older versions and history are editor-only. Go through `accessLevel`/`canView`/`canEdit`; don't re-implement checks in routes.
- **Blobs are shared and immutable.** Content lives under `blobs/<sha256>`; rows only hold hashes. Only the API writes there: direct uploads land under `uploads/<id>/` and are hashed before they become blobs. Anything that uploads blobs and then writes rows that reference them must call `holdStorageLock(tx)` inside the same transaction first, or the sweep can delete a blob between upload and commit.
- **Version numbers.** Publish and restore lock the page row (`for update`) before picking the next number. Restore never rewrites history; it publishes the old content as a new version.
- **Tokens are stored hashed** (`hashToken`): sessions, email links, invitations, OAuth codes and tokens. Links work once; delete the row as it is used.
- **Email links must survive mail scanners.** Opening a sign-in link only shows a confirmation page; the POST on Continue uses it up.
- **New accounts.** Creating accounts and changing admins take `lockAdmins(tx)`. Insert new users with `...(await newAccountFields(tx))`: on a self-hosted install the first account becomes admin and goes through onboarding, and later ones start onboarded in their personal workspace.
- **Untrusted HTML.** Page content is served with `CONTENT_CSP` (sandbox, opaque origin) on every file, never with the app's cookies. Thumbnails intercept every request; see the header comment in `src/thumbnails.ts` before touching it.
- **Limits.** New endpoints that send email or create accounts, clients or content go through `limitRequest` (or `hit`) from `src/limits.ts`, with a limit added to its list and to `docs/configuration.md`. Anything that adds a version calls `checkQuota` inside its transaction.
- Shared helpers: `EMAIL_RE` and `UUID_RE` in `src/validation.ts`, `likeTerm` in `src/artifacts.ts` for escaped `ILIKE` searches, `checkTitle` for page names.

## Migrations

1. Edit `src/db/schema.ts`.
2. `pnpm db:generate` (from the repo root) writes `drizzle/NNNN_*.sql` and `drizzle/meta/*`. Rename the SQL file to say what it does if the generated name is random, and update the `tag` in `drizzle/meta/_journal.json` to match.
3. Commit the SQL, the snapshot and the journal together. Never edit a migration that has shipped; add a new one.
4. `pnpm db:migrate` locally. Tests migrate `artifact_test` themselves.

## Tests

- `test/unit/` — pure functions, no services.
- `test/integration/` — calls `app.request()` in-process against `artifact_test` and the `artifact-test` bucket. Every table is truncated before each test and files run serially.
- Use the helpers in `test/integration/helpers.ts` (`createUser`, `createOrg`, `createPage`, `connectAgent`, `callTool`, `call`) rather than building requests by hand.
- `src/mail.ts` is replaced by a mock in `test/integration/setup.ts` that only has the send functions. Keep non-mail code out of `mail.ts`, and add any new send function to that mock (`src/ee/mail.ts` has a mock of its own).
- `vitest.config.ts` pins `SELF_HOSTED=false` and SMTP on. Tests that need other modes change the `env` object and restore it in `afterEach` (see `admin.test.ts`, `no-email.test.ts`).
- `pnpm --filter @the-artifact/api lint` type-checks `src` and `test` together.
