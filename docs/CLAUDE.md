# docs/

Markdown that ships inside the app at `/docs/<file name>` (bundled by `apps/web/src/docs.ts` at build time) and also reads on GitHub. Two audiences: people using pages and agents, and operators running a self-hosted server.

## Adding or renaming a page

1. Add `docs/<slug>.md` with a single `#` title.
2. List it in `USING`, `RUNNING` or `REFERENCE` in `apps/web/src/docs.ts`, or it never shows in the sidebar.
3. Link to it from related pages.

## Writing

- Plain second person, short sentences, present tense. Say what happens, not what "will" happen. No marketing words, no exclamation marks.
- UI labels in bold exactly as they appear (**Share**, **Server admin**, **Continue**); env vars, paths, commands and MCP tool names in backticks.
- Say "page", not "artifact".
- Tables for settings, roles and limits; fenced code blocks tagged `sh`, `html`, `json`, `toml` or `yaml` (those get a label and a copy button).
- Use `{{MCP_URL}}` and `{{APP_URL}}` in examples; the app fills in the install's own address.

## Links

- Between pages: `/docs/<slug>` or `/docs/<slug>#<heading-anchor>`. `<slug>.md` links also work and are rewritten.
- Anchors are made the way GitHub makes them, so a link works in the app and on GitHub: the heading lowercased, punctuation other than `-` and `_` dropped, each space turned into `-` (`## 3. The seccomp profile` → `#3-the-seccomp-profile`, `### update_files` → `#update_files`, `## Webhooks can't reach private networks` → `#webhooks-cant-reach-private-networks`). Renaming a heading breaks links to it, so search for the old anchor.
- Repository files are referenced by path in backticks (`deploy/docker-compose/docker-compose.yml`), not linked.

## Keeping it true

Numbers and names here come from code; check them when you change it:

| Doc | Source of truth |
| --- | --- |
| `configuration.md` env vars and defaults | `apps/api/src/env.ts`, `Dockerfile`, `deploy/` |
| `configuration.md` limits | `apps/api/src/files.ts`, `artifacts.ts`, `sharing.ts`, `comments.ts`, `auth/`, `oauth/server.ts`, `thumbnails.ts`, `limits.ts`, `quota.ts`, `ee/plans.ts` |
| `publishing.md` tools and arguments | `apps/api/src/mcp.ts` |
| `sharing.md`, `organizations.md` roles | `apps/api/src/artifacts.ts` (`accessLevel`), `routes/members.ts` |
| `security.md` | `apps/api/src/content.ts`, `embeds.ts`, `previews.ts`, `thumbnails.ts`, `network.ts`, `webhooks.ts`, `auth/` |
| `webhooks.md` | `apps/api/src/webhooks.ts` (events, payload, retry delays, limits), `routes/webhooks.ts` |
| `self-hosting.md`, `kubernetes.md`, `backups.md` | `deploy/`, `Dockerfile` |
| `licenses.md` | `apps/api/src/license.ts` (format, grace days, messages), `routes/license.ts`, `ee/licenses.ts`, `scripts/license-keygen.ts` |
