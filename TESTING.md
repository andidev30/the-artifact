# Testing

| Suite | Tool | Where | Needs |
| --- | --- | --- | --- |
| Unit | Vitest | `apps/api/test/unit`, `apps/web/src/**/*.test.ts` | nothing |
| Integration | Vitest + Hono `app.request()` | `apps/api/test/integration` | Postgres |
| End-to-end | Playwright | `e2e/` | Postgres, Mailpit, Google Chrome |

Start the services first with `pnpm services` (Postgres on 5432, Mailpit on 1025/8025), and create the test database once:

```sh
docker compose exec postgres createdb -U artifact artifact_test
```

Tests never read `apps/api/.env`. They set their own environment and only use the `artifact_test` database (override with `TEST_DATABASE_URL`, which must still contain `artifact_test`). Migrations from `apps/api/drizzle` run automatically before the integration and e2e suites.

## Run

```sh
pnpm test                                        # unit + integration, every package
pnpm test:e2e                                    # Playwright
pnpm --filter @the-artifact/api test:unit        # API unit tests only, no database
pnpm --filter @the-artifact/api test:integration
pnpm --filter @the-artifact/web test
pnpm lint                                        # includes a type check of the API tests
```

## Integration tests

They call the Hono app in-process, so no server runs. Every table in the `public` schema is truncated before each test, and files run one at a time because they share the database. Email is mocked (`vi.mock` of `src/mail.ts`), so Mailpit isn't needed; tests assert on the mocked `sendSignInLink` and `sendShareNotice` calls. Helpers in `test/integration/helpers.ts` create signed-in users, organizations, pages and complete MCP OAuth connections.

## End-to-end tests

`playwright.config.ts` starts two servers on dedicated ports, so a dev setup on 3000/5173 can keep running:

- API on `3004` against `artifact_test`, with `APP_URL=http://localhost:5177` and SMTP to Mailpit on `localhost:1025`
- Web app on `5177`, proxying to the API through `API_URL`

The ports must be free; existing servers are not reused. Sign-in links and share emails are read from Mailpit's API (`MAILPIT_URL`, default `http://localhost:8025`). Each test uses unique email addresses and doesn't clean up, so tests can run in parallel and repeat.

Playwright uses the installed Google Chrome (`channel: 'chrome'`). Without Chrome, run `npx playwright install chromium` and set `PW_CHROMIUM=1`.

On failure, traces are kept in `test-results/`; open one with `npx playwright show-trace <file>`.
