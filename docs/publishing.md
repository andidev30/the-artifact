# Publishing pages

Agents publish through five MCP tools. You don't call them yourself: ask the agent in plain words and it picks the right one.

## What makes a good page

- **One self-contained HTML document.** Inline the CSS and JavaScript. Scripts from public CDNs load fine.
- **Up to 2 MB.** Compress images or load them from a URL instead of embedding large files.
- **A short title.** It shows in the gallery and the browser tab (up to 200 characters).

Pages run in a sandboxed frame: scripts, forms, pop-ups and downloads work, but a page can't read cookies, use `localStorage` on the app's origin, or talk to the rest of The Artifact.

## Tools

### publish_artifact

Publishes a page and returns its link.

| Argument | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Title for the gallery and tab |
| `html` | yes | The complete HTML document |
| `artifact_id` | no | Id or link of an existing page. Publishes a new version at the same link. |
| `visibility` | no | `private`, `organization` or `link` (see [Sharing](/docs/sharing)) |

New pages are private in a personal workspace and visible to the organization in an organization workspace.

### list_artifacts

Lists the most recently updated pages in the connected workspace, with their ids and links.

### get_artifact

Returns the current HTML of a page, so the agent can edit it and publish a new version.

### set_artifact_visibility

Changes who can open a page without publishing a new version.

### share_artifact

Shares a page with people by email, as `viewer` or `editor`, with an optional message. They get an email with the link.

## Updating a page

Ask for the change in the same conversation ("make the chart a line chart"). The agent reads the page with `get_artifact`, edits it and publishes with the same `artifact_id`. The link stays the same, the version number goes up, and the old version stays in the [history](/docs/version-history).

## Managing pages in the app

In the gallery and the page viewer, the **…** menu lets editors rename a page and lets the owner delete it. Search above the gallery filters by title.
