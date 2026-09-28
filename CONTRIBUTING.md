# Contributing

Thanks for helping. Bug reports, fixes, docs and features are all welcome. For anything larger than a small fix, open an issue first so we can agree on the approach before you write the code. What's planned, and what is up next, is on the [project board](https://github.com/users/andidev30/projects/2); issues in **Todo** are good places to start.

## Getting set up

Follow [Development](README.md#development) in the README, then [TESTING.md](TESTING.md) for the test database. You need Node 26 (see `.nvmrc`), pnpm 11 (`npm install -g pnpm`), Docker and, for end-to-end tests, Google Chrome.

Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once, so `git blame` skips commits that only reformatted code (GitHub does this on its own). A commit that only reformats goes into that file.

`CLAUDE.md` in the root and in each app describes how the code is laid out and the rules that aren't obvious from one file. They are written for coding agents but are the best map for people too.

## Making a change

- Keep a pull request to one change. Run `pnpm format` before committing; Biome formats and lints the code, and CI fails on anything it would change. The Biome extension for your editor does the same on save.
- Every change has to work on a self-hosted install and on the hosted service, with and without email (see "Modes every change has to work in" in `CLAUDE.md`).
- Add or update tests: integration tests in `apps/api/test/integration` for API behaviour, Playwright specs in `e2e/` for flows in the browser.
- Update `docs/` when behaviour changes. The docs ship inside the app.
- Schema changes go through `pnpm db:generate`; commit the migration with the snapshot.
- Before you push: `pnpm lint` and `pnpm test` (and `pnpm test:e2e` for UI flows). CI runs all of them.

Commit messages follow the style in the log: `feat: …`, `fix(web): …`, `refactor(api): …`, `docs: …`. They become the release notes, so write the subject for someone running a server.

## Releases

Releases are made by [release-please](https://github.com/googleapis/release-please) from the commit messages on `main`:

- Each push to `main` updates an open pull request titled `chore: release x.y.z`, with the next version, its `CHANGELOG.md` entry and the version bumped in `package.json` and the files in `deploy/`.
- Merging that pull request tags `vx.y.z`, creates the GitHub release with the same notes, and publishes the image as `x.y.z`, `x.y` and `latest`. Every push to `main` is also published as `main`.

The CLI in `packages/cli` is released on its own, from the commits that touch it (use the `cli` scope), and they stay out of the server's notes:

- It has its own pull request, `chore(cli): release x.y.z`, with `packages/cli/CHANGELOG.md` and the version in `packages/cli/package.json`.
- Merging it tags `cli-vx.y.z`, creates its GitHub release (not marked latest, which stays the server's) and publishes `@the-artifact/cli` to npm with provenance. That needs the `NPM_TOKEN` repository secret: an npm granular access token with read and write access to `@the-artifact/cli`.

Pull requests are merged with **Rebase and merge**, or with a merge commit whose description is left empty. release-please reads every commit, and a merge commit that repeats the pull request title in its description lists the change a second time.

Which commits go into the notes, and how they move the version:

| Commit | Section | Version before 1.0.0 | From 1.0.0 |
| --- | --- | --- | --- |
| `feat:` | Features | minor | minor |
| `fix:` | Bug fixes | patch | patch |
| `perf:` | Performance | patch | patch |
| `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer | ⚠ BREAKING CHANGES | minor | major |
| `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:` | not listed | none | none |

The scope stays in the notes (`**api:** …`), so use one when a change is limited to one part. [Upgrading](docs/upgrading.md#what-counts-as-breaking) lists what is breaking: removed or renamed settings and changed defaults, migrations the previous version can't run on, MCP tool and argument changes, removed API routes, and deploy files operators have to edit. Mark those with `!` and write the footer as what the operator has to do:

```
feat(api)!: read the storage bucket from S3_BUCKET only

BREAKING CHANGE: ARTIFACT_BUCKET is no longer read. Rename it to S3_BUCKET in app.env before you upgrade.
```

When a change needs operators to act on upgrade, breaking or not (a setting to add, a command to run, a file to edit), add or extend the section `## Upgrading to x.y.z` at the end of `docs/upgrading.md` in the same pull request, with the version the open release pull request proposes. When the release is made, that section is added to the GitHub release under **Upgrading**. Before merging the release pull request, check that the version in the heading still matches.

## Licensing of contributions

Code outside `ee/` folders is AGPL-3.0 ([LICENSE](LICENSE)), and your contributions there are licensed the same way. Code in `ee/` folders is under [LICENSE-EE](LICENSE-EE); contributions there are licensed to the maintainer under that license.

## Security issues

Don't open a public issue; see [SECURITY.md](SECURITY.md).
