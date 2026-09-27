# The Artifact

[![CI](https://github.com/andidev30/the-artifact/actions/workflows/ci.yml/badge.svg)](https://github.com/andidev30/the-artifact/actions/workflows/ci.yml)

Your agent writes the page. You send the link.

The Artifact hosts the HTML pages coding agents build. Claude Code, Cursor, Codex or any MCP client publishes a page through an MCP server and gets a link back; you choose who can open it.

- [Documentation](docs/introduction.md)
- [Self-hosting](docs/self-hosting.md) with Docker Compose, or on [Kubernetes](docs/kubernetes.md)
- [Testing](TESTING.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Development

```sh
pnpm install
pnpm services        # Postgres, MinIO (console http://localhost:9001) and Mailpit (http://localhost:8025) in Docker
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm dev             # API on :3000, web on :5173
```

`apps/api` is the Hono API, MCP server and OAuth server; `apps/web` is the React app. Code that only the hosted service uses lives in `ee/` folders inside each app. Docs pages live in `docs/` and are rendered at `/docs`.

Working with Claude Code: `CLAUDE.md` files at the root and in `apps/api`, `apps/web`, their `ee/` folders, `docs` and `deploy` describe the conventions, and `.claude/` holds shared settings, plugins and the project skills `run-app`, `verify`, `db-migration` and `docs-sync`.

## License

The Artifact is free software under the [GNU Affero General Public License v3.0](LICENSE): you can self-host it, change it and share it, and if you run a modified version as a service you share your changes too.

The code in `ee/` folders (`apps/api/src/ee`, `apps/web/src/ee`) powers the hosted service only (its marketing site, contact form and workspace choice) and is under the separate [Enterprise License](LICENSE-EE). A self-hosted install doesn't use it.
