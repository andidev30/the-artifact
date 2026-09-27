---
name: verify
description: Run the right checks for a change in this repo before calling it done - lint, unit, integration and e2e tests, docs sync. Use after editing code, before committing, or when asked to test.
---

# Verify a change

Always:

```sh
pnpm format      # Biome: format and safe fixes
pnpm lint
pnpm --filter @the-artifact/api test:unit
pnpm --filter @the-artifact/web test
```

Then by what changed:

| Changed | Also run |
| --- | --- |
| Anything in `apps/api/src` | `pnpm --filter @the-artifact/api test:integration` |
| A UI flow that talks to the API (sign-in, sharing, invitations, admin, publish) | `pnpm test:e2e e2e/<matching>.spec.ts` |
| `apps/web` styles or layout | `pnpm --filter @the-artifact/web build`, and look at it at phone width with the `run-app` skill |
| `Dockerfile` or `deploy/` | `docker build .` |
| Behaviour, settings, limits, MCP tools | the `docs-sync` skill |

## Services

Integration and e2e tests need `pnpm services` and the test database (once: `docker compose exec postgres createdb -U artifact artifact_test`). e2e also needs Google Chrome (or `PW_CHROMIUM=1` after `npx playwright install chromium`) and free ports 3004, 3005, 5177 and 5178. If a service isn't available, say which suites were skipped instead of reporting them as passing.

## New tests

- API: add to the matching `apps/api/test/integration/*.test.ts` using `helpers.ts`. Cover the no-email path (`no-email.test.ts` pattern) when the feature sends mail.
- Web: pure logic goes in a module with a `*.test.ts` next to it; flows go in `e2e/`.
