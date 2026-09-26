# The Artifact

Your agent writes the page. You send the link.

The Artifact hosts the HTML pages coding agents build. Claude Code, Cursor, Codex or any MCP client publishes a page through an MCP server and gets a link back; you choose who can open it.

- [Documentation](docs/introduction.md)
- [Self-hosting](docs/self-hosting.md)
- [Testing](TESTING.md)

## Development

```sh
pnpm install
pnpm services        # Postgres, MinIO (console http://localhost:9001) and Mailpit (http://localhost:8025) in Docker
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm dev             # API on :3000, web on :5173
```

`apps/api` is the Hono API, MCP server and OAuth server; `apps/web` is the React app. Docs pages live in `docs/` and are rendered at `/docs`.
