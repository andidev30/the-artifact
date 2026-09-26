# Introduction

The Artifact hosts the HTML pages your coding agent builds: reports, prototypes, dashboards, one-off tools. The agent publishes a page through an MCP server and gets a link back. You decide who can open it.

## How it works

1. **Connect your agent once.** Add The Artifact as an MCP server in Claude Code, Cursor, Codex or any MCP client. The first time it connects, your browser opens so you can sign in and choose a workspace.
2. **Ask for a page.** In plain words, like "turn this CSV into a chart I can send to the team". The agent writes a self-contained HTML page and calls `publish_artifact`.
3. **Send the link.** The agent replies with a link like `{{APP_URL}}/a/k3x9…`. Ask for a change and it publishes a new version to the same link.

## What you get

- **One link for every revision.** Republishing keeps the address, and older versions stay in the history.
- **Private until you share it.** Share with specific people by email, with everyone in your organization, or with anyone who has the link.
- **A gallery** of everything published in a workspace, plus pages others shared with you.
- **Pages run in a sandbox.** A page's scripts run, but they can't read your session or reach the rest of the app.

## Where to go next

- [Connect your agent](/docs/connect-your-agent)
- [Publishing pages](/docs/publishing)
- [Sharing and permissions](/docs/sharing)
- [Self-hosting](/docs/self-hosting)
