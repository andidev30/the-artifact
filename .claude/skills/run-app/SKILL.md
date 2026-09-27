---
name: run-app
description: Start The Artifact locally (Postgres, MinIO, Mailpit, API, web) and sign in, to see a change working in the real app. Use when asked to run, start, open or screenshot the app, or to try a flow by hand.
---

# Run The Artifact locally

1. Services (idempotent): `pnpm services`, then `docker compose ps` until postgres, minio and mailpit are up.
2. First time only:
   - `cp apps/api/.env.example apps/api/.env` if it doesn't exist (never overwrite an existing one).
   - `pnpm db:migrate`
3. Start both apps in the background: `pnpm dev`. API on http://localhost:3000, web on http://localhost:5173. Wait until `curl -s localhost:3000/api/config` answers.
4. Open http://localhost:5173.

## Signing in

- Default `.env` sends mail to Mailpit. Request a link on `/login`, then read it at http://localhost:8025 (or `curl -s localhost:8025/api/v1/messages`). The link opens a confirmation page; press **Continue**.
- The first account on a self-hosted install (the default) becomes the instance admin and can open `/admin`.
- To grant admin to an existing account: `pnpm --filter @the-artifact/api admin:grant you@example.com`.

## Other modes

Set these in `apps/api/.env` and restart the API:

| Try | Set |
| --- | --- |
| No email (password sign-in, links passed on by hand) | `SMTP_HOST=` |
| Hosted service with marketing pages | `SELF_HOSTED=false` |
| Gallery thumbnails | `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` |

## Publishing a page as an agent would

Connect an MCP client to `http://localhost:5173/mcp` (Claude Code: `claude mcp add --transport http the-artifact-dev http://localhost:5173/mcp`), sign in through the browser, then call `publish_artifact`. The flow is also scripted in `e2e/helpers.ts` (`connectAgent`).

Stop the dev servers when done; leave the Docker services running unless asked.
