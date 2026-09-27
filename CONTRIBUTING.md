# Contributing

Thanks for helping. Bug reports, fixes, docs and features are all welcome. For anything larger than a small fix, open an issue first so we can agree on the approach before you write the code.

## Getting set up

Follow [Development](README.md#development) in the README, then [TESTING.md](TESTING.md) for the test database. You need Node 24, pnpm (via `corepack enable`), Docker and, for end-to-end tests, Google Chrome.

`CLAUDE.md` in the root and in each app describes how the code is laid out and the rules that aren't obvious from one file. They are written for coding agents but are the best map for people too.

## Making a change

- Keep a pull request to one change. Match the style of the file you are in; there is no formatter.
- Every change has to work on a self-hosted install and on the hosted service, with and without email (see "Modes every change has to work in" in `CLAUDE.md`).
- Add or update tests: integration tests in `apps/api/test/integration` for API behaviour, Playwright specs in `e2e/` for flows in the browser.
- Update `docs/` when behaviour changes. The docs ship inside the app.
- Schema changes go through `pnpm db:generate`; commit the migration with the snapshot.
- Before you push: `pnpm lint` and `pnpm test` (and `pnpm test:e2e` for UI flows). CI runs all of them.

Commit messages follow the style in the log: `feat: …`, `fix(web): …`, `refactor(api): …`, `docs: …`.

## Licensing of contributions

Code outside `ee/` folders is AGPL-3.0 ([LICENSE](LICENSE)), and your contributions there are licensed the same way. Code in `ee/` folders is under [LICENSE-EE](LICENSE-EE); contributions there are licensed to the maintainer under that license.

## Security issues

Don't open a public issue; see [SECURITY.md](SECURITY.md).
