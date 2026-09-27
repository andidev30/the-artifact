# @the-artifact/api

The Hono API, the MCP server at `/mcp`, the OAuth server MCP clients sign in through, and the thumbnail renderer.

```sh
cp .env.example .env
pnpm dev:api   # from the repository root; http://localhost:3000
pnpm db:migrate
pnpm --filter @the-artifact/api test
```

Settings are described in [docs/configuration.md](../../docs/configuration.md), tests in [TESTING.md](../../TESTING.md).

Operator scripts (in the Docker image: `node dist/scripts/<name>.js`):

| Script | Does |
| --- | --- |
| `pnpm --filter @the-artifact/api admin:grant you@example.com` | Makes an account an instance admin |
| `pnpm --filter @the-artifact/api storage:sweep` | Removes blobs nothing refers to |
| `pnpm --filter @the-artifact/api thumbnails:backfill [--retry-failed]` | Renders missing gallery thumbnails |
