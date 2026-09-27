# apps/api

Hono on Node 24, Drizzle ORM over `postgres`, S3 via `@aws-sdk/client-s3`, MCP via `@modelcontextprotocol/server`, thumbnails via `playwright-core` driving headless Chromium. Runs with `tsx watch` in dev, `tsc` → `dist/` in production.

## Where things are

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Boot: optional migrations (`MIGRATE_ON_START`), bucket check, storage sweeps, HTTP server |
| `src/app.ts` | Mounts every router; `GET /api/config` and `GET /api/me` |
| `src/env.ts` | Environment variables. Add new settings here and read them from `env` |
| `src/db/schema.ts` | Tables. `src/db/index.ts` exports `db`, `schema` and the `Tx` type |
| `src/artifacts.ts` | Pages and versions: access rules (`accessLevel`, `canView`, `canEdit`), publish, restore, listing |
| `src/content.ts` | Serves a version as a document tree at `/api/artifacts/<slug>/v/<n>/…`, link tokens for sandboxed frames |
| `src/files.ts` | Multi-file page validation and size limits |
| `src/storage.ts`, `src/gc.ts` | Content-addressed blobs in S3 and the sweep that deletes unreferenced ones |
| `src/thumbnails.ts` | Gallery screenshots of untrusted HTML with no network of its own |
| `src/sharing.ts` | Per-person shares by email |
| `src/instance.ts` | Instance admins, sign-up policy and instance settings |
| `src/mcp.ts` | The six MCP tools (`publish_artifact`, `list_artifacts`, `get_artifact`, `rename_artifact`, `set_artifact_visibility`, `share_artifact`) |
| `src/oauth/` | OAuth 2.1 server for MCP clients (discovery, dynamic registration, PKCE) and the consent API |
| `src/auth/` | Sessions, email links, passwords, Google sign-in, account lookup/creation |
| `src/routes/` | REST routers for the web app |
| `src/mail.ts` | Every outgoing email. Throws `MailDisabledError` without SMTP |
| `src/scripts/` | Operator CLIs (`admin:grant`, `storage:sweep`, `thumbnails:backfill`), also run as `node dist/scripts/*.js` in the image |

## Rules that aren't obvious from one file

- **Access.** Owners and invited editors edit; invited viewers view; organization admins and owners edit every page in their organization; general access (`private` shown as "Restricted", `organization`, `link`) opens a page wider. Older versions and history are editor-only. Go through `accessLevel`/`canView`/`canEdit`; don't re-implement checks in routes.
- **Blobs are shared and immutable.** Content lives under `blobs/<sha256>`; rows only hold hashes. Anything that uploads blobs and then writes rows that reference them must call `holdStorageLock(tx)` inside the same transaction first, or the sweep can delete a blob between upload and commit.
- **Version numbers.** Publish and restore lock the page row (`for update`) before picking the next number. Restore never rewrites history; it publishes the old content as a new version.
- **Tokens are stored hashed** (`hashToken`): sessions, email links, invitations, OAuth codes and tokens. Links work once; delete the row as it is used.
- **Email links must survive mail scanners.** Opening a sign-in link only shows a confirmation page; the POST on Continue uses it up.
- **Serialized admin changes.** Creating accounts and changing admins take `lockAdmins(tx)` so there is always one admin and only the first account on a self-hosted install becomes admin.
- **Untrusted HTML.** Page content is served with `CONTENT_CSP` (sandbox, opaque origin) on every file, never with the app's cookies. Thumbnails intercept every request; see the header comment in `src/thumbnails.ts` before touching it.
- Shared helpers: `EMAIL_RE` in `src/validation.ts`, `likeTerm` in `src/artifacts.ts` for escaped `ILIKE` searches, `checkTitle` for page names.

## Migrations

1. Edit `src/db/schema.ts`.
2. `pnpm db:generate` (from the repo root) writes `drizzle/NNNN_*.sql` and `drizzle/meta/*`. Rename the SQL file to say what it does if the generated name is random, and update the `tag` in `drizzle/meta/_journal.json` to match.
3. Commit the SQL, the snapshot and the journal together. Never edit a migration that has shipped; add a new one.
4. `pnpm db:migrate` locally. Tests migrate `artifact_test` themselves.

## Tests

- `test/unit/` — pure functions, no services.
- `test/integration/` — calls `app.request()` in-process against `artifact_test` and the `artifact-test` bucket. Every table is truncated before each test and files run serially.
- Use the helpers in `test/integration/helpers.ts` (`createUser`, `createOrg`, `createPage`, `connectAgent`, `callTool`, `call`) rather than building requests by hand.
- `src/mail.ts` is replaced by a mock in `test/integration/setup.ts` that only has the send functions. Keep non-mail code out of `mail.ts`, and add any new send function to that mock.
- `vitest.config.ts` pins `SELF_HOSTED=false` and SMTP on. Tests that need other modes change the `env` object and restore it in `afterEach` (see `admin.test.ts`, `no-email.test.ts`).
- `pnpm --filter @the-artifact/api lint` type-checks `src` and `test` together.
