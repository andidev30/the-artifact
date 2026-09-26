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

A connection publishes to one workspace: your personal workspace or one of your organizations. To publish somewhere else, disconnect the agent in **Settings → Connected agents** and connect it again.

## Disconnecting

**Settings → Connected agents** lists every agent with access, the workspace it publishes to, and when it was last used. **Disconnect** revokes its access at once; the agent has to sign in again to publish.
