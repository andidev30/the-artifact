---
name: docs-sync
description: Check docs/ and the README, CLAUDE.md and .env.example files against the code and fix what is stale. Use after changing behaviour, settings, limits, MCP tools or deploy files, or when asked to update the docs.
---

# Bring the docs up to date

The docs in `docs/` ship inside the app at `/docs`, so stale text is a user-facing bug. Follow `docs/CLAUDE.md` for style.

1. Find what changed: `git diff main...HEAD --stat` (or the working tree diff).
2. For each change, check its source of truth against the docs:
   - Env vars: every `process.env.*` in `apps/api/src` and `env.ts` appears in `docs/configuration.md` with the right default; operator-facing ones also in `apps/api/.env.example` and `deploy/**/*.env.example`.
   - Limits: constants in `apps/api/src/files.ts`, `artifacts.ts`, `sharing.ts`, `auth/*.ts`, `oauth/server.ts`, `thumbnails.ts` match the Limits table in `docs/configuration.md`; the rate limits in `limits.ts` match its Rate limits table, and `ee/plans.ts` matches `docs/publishing.md` and `apps/web/src/ee/Pricing.tsx`.
   - MCP tools: names, arguments and descriptions in `apps/api/src/mcp.ts` match `docs/publishing.md`.
   - Roles and access: `accessLevel` in `apps/api/src/artifacts.ts` and `routes/members.ts` match `docs/sharing.md` and `docs/organizations.md`.
   - UI labels quoted in bold still exist in `apps/web/src` (`git grep -n '<label>'`).
   - Deploy: commands and paths in `docs/self-hosting.md`, `docs/kubernetes.md`, `docs/backups.md` exist in `deploy/` and the `Dockerfile`.
3. Check links: every `/docs/<slug>#<anchor>` points at an existing file and heading, and every page is listed in `apps/web/src/docs.ts`.
4. Update `CLAUDE.md` files and READMEs when a module, command or convention they describe moved.
5. Report what was stale and what you changed; don't rewrite text that is still true.
