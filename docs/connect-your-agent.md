# Connect your agent

The Artifact is an MCP server that speaks streamable HTTP at:

```
{{MCP_URL}}
```

Add it once. The first time the agent connects, it opens your browser: sign in, pick the workspace the agent should publish to, and choose **Allow**.

## Claude Code

```sh
claude mcp add --transport http --scope user the-artifact {{MCP_URL}}
```

`--scope user` makes it available in every project. Then run `/mcp` inside Claude Code, pick `the-artifact` and choose **Authenticate**.

## Cursor

Add this to `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "the-artifact": {
      "url": "{{MCP_URL}}"
    }
  }
}
```

Cursor asks you to sign in when it first connects.

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.the-artifact]
url = "{{MCP_URL}}"
```

Then sign in and restart Codex:

```sh
codex mcp login the-artifact
```

## Other MCP clients

Any client that supports MCP over streamable HTTP with OAuth can connect with the URL above. It discovers the sign-in server on its own from the `401` response (`WWW-Authenticate` with `resource_metadata`), registers itself, and uses the authorization code flow with PKCE.

## Choosing a workspace

A connection publishes to one workspace: your personal workspace or one of your organizations. To publish somewhere else, disconnect the agent in **Account settings → Connected agents** and connect it again.

## Disconnecting

**Account settings → Connected agents** lists every agent with access, the workspace it publishes to, and when it was last used. **Disconnect** revokes its access at once; the agent has to sign in again to publish. The [command line](/docs/publishing#command-line) shows there as **The Artifact CLI**, and `the-artifact logout` disconnects it too.

## Publishing from CI

A CI job (a test report, a nightly dashboard) can't open a browser to sign in. Give it an access token instead.

1. Open **Account settings → Access tokens**, enter a name, pick the workspace it publishes to and when it expires (7, 30 or 90 days, 1 year, or no expiry; 90 days unless you choose), and choose **Create token**.
2. Copy the token. It starts with `art_` and is shown once; only a hash of it is stored.
3. Save it as a secret where the job runs, e.g. a GitHub Actions secret named `ARTIFACT_TOKEN`.

A token acts for you in that one workspace, with your permissions, like a connected agent. It works as a bearer token for `POST /api/publish` (see [Publishing without an agent](/docs/publishing#publishing-without-an-agent)) and for every MCP tool at `{{MCP_URL}}`. It can't sign in to the app or make other tokens.

**Account settings → Access tokens** lists your tokens with their workspace, when they were made and last used, and when they expire. **Revoke** stops a token at once: the next request with it is refused. A token also stops working when it expires, when you leave the organization it is for, or when your account is suspended. Owners and admins of an organization can see and revoke its members' tokens for it (see [Organizations](/docs/organizations#access-tokens)).

### GitHub Actions

This workflow publishes a report the tests write to `report/` (an `index.html` and the files it loads) after every push to `main`, as a new version of the same page each time. The first run creates the page and prints its `id`; save it as the repository variable `REPORT_PAGE_ID` so later runs update that page and its link stays the same.

```yaml
name: Test report
on:
  push:
    branches: [main]

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
      - name: Publish the report
        if: always()
        env:
          ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}
          PAGE_ID: ${{ vars.REPORT_PAGE_ID }}
        run: |
          cd report
          args=(-F "title=Test report for ${GITHUB_SHA::7}")
          if [ -n "$PAGE_ID" ]; then args+=(-F "artifact_id=$PAGE_ID"); fi
          while IFS= read -r f; do args+=(-F "$f=@$f"); done < <(find . -type f | sed 's|^\./||')
          curl -fsS {{APP_URL}}/api/publish -H "Authorization: Bearer $ARTIFACT_TOKEN" "${args[@]}"
```

Each file of the folder goes up as a form part named by its path, with `index.html` as the page itself. Only [the file types pages allow](/docs/publishing#publish_artifact) are accepted. The answer is JSON with the page's `id` and `url`.

The [command line](/docs/publishing#command-line) does the same in one step. It leaves out hidden files and types pages can't hold, and prints only the link:

```yaml
      - name: Publish the report
        if: always()
        env:
          THE_ARTIFACT_URL: {{APP_URL}}
          THE_ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}
        run: npx @the-artifact/cli publish report --title "Test report for ${GITHUB_SHA::7}" --id "${{ vars.REPORT_PAGE_ID }}"
```

For a single HTML file, send JSON:

```sh
jq -n --rawfile html dashboard.html '{title: "Nightly dashboard", html: $html}' |
  curl -fsS {{APP_URL}}/api/publish -H "Authorization: Bearer $ARTIFACT_TOKEN" -H 'Content-Type: application/json' --data-binary @-
```

A job that runs an agent can give it the token instead of signing in, as an `Authorization` header on the MCP server. For Claude Code:

```sh
claude mcp add --transport http the-artifact {{MCP_URL}} --header "Authorization: Bearer $ARTIFACT_TOKEN"
```
