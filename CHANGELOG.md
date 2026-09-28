# Changelog

Every release of The Artifact, newest first. Entries are generated from the commit messages when a release is made; what you have to do when you upgrade is in [Upgrading](docs/upgrading.md), and the versioning policy is there too.

## [0.1.0](https://github.com/andidev30/the-artifact/releases/tag/v0.1.0) (2026-09-27)

First release: hosting for the HTML pages coding agents publish over MCP.

### Features

* MCP server with tools to publish, list, read, rename, share and change access to pages, with OAuth 2.1 sign-in for MCP clients
* Single-file and multi-file pages served in a sandboxed frame, with version history and restore
* Sharing by email as viewer or editor, organization-wide or by link
* Organizations with owners, admins and members, and invitations
* Gallery thumbnails rendered in headless Chromium
* Server admin area: people, organizations and the sign-up policy
* Runs with or without SMTP
* Image `ghcr.io/andidev30/the-artifact:0.1.0` for linux/amd64 and linux/arm64
