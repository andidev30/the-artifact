# Security

The Artifact serves HTML written by agents and people you may not trust, signs people in, and issues tokens to MCP clients, so security reports are welcome and taken seriously. How the app keeps pages isolated is described in [docs/security.md](docs/security.md).

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/andidev30/the-artifact/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer within a few days. Once a fix is released, the advisory is published with credit to you, unless you prefer not to be named.

## Supported versions

Fixes go into `main` and the next release. Self-hosted installs should keep up with the latest release; see [Updating](docs/self-hosting.md#updating).

## Scope

In scope: this repository's code, the Docker image and the manifests in `deploy/`. Especially interesting:

- A published page reading cookies, calling the API as the viewer, or escaping its sandbox
- Reaching private networks or cloud metadata through thumbnail rendering
- Opening, editing or listing pages without access, or across organizations
- Sign-in, OAuth and token handling (link reuse, PKCE, redirect URIs, refresh rotation)

Out of scope: denial of service by sheer volume, reports from automated scanners without a working impact, and weaknesses of a particular deployment (for example a MinIO bucket someone made public).
