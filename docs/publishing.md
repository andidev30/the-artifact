# Publishing pages

Agents publish through six MCP tools. You don't call them yourself: ask the agent in plain words and it picks the right one.

## What makes a good page

- **One HTML document, or a small site.** A single self-contained document (inline CSS and JavaScript) is simplest. When a page is easier to build from several files, the agent sends the HTML as the entry plus its CSS, JavaScript, images, fonts and data, referenced by relative paths like `css/site.css` or `img/logo.png`. Scripts and fonts from public CDNs load fine either way.
- **Small.** The HTML can be up to 2 MB, each other file up to 5 MB, and all of it together up to 10 MB in at most 100 files. Compress images, or load large media from a URL.
- **A short title.** It shows in the gallery and the browser tab (up to 200 characters).

Pages run in a sandboxed frame: scripts, forms, pop-ups and downloads work, but a page can't read cookies, use `localStorage` on the app's origin, or talk to the rest of The Artifact. Its own files load normally, including with `fetch()`.

The gallery shows a screenshot of each page, taken on the server a few seconds after it is published (see [Security](/docs/security) for how). Until it exists, a card shows a sketch.

## Tools

### publish_artifact

Publishes a page and returns its link.

| Argument | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Title for the gallery and tab |
| `html` | yes | The complete HTML document. For a multi-file page, the entry (`index.html`). |
| `files` | no | Other files of the page: a list of `{ path, content, encoding }` (see below) |
| `artifact_id` | no | Id or link of an existing page. Publishes a new version at the same link. |
| `visibility` | no | `private` (shown as **Restricted**), `organization` or `link` (see [Sharing](/docs/sharing)) |

Each file in `files` has:

| Field | Meaning |
| --- | --- |
| `path` | Where the HTML finds it, relative to the page: `app.js`, `css/site.css`, `img/logo.png`. Letters, digits and `. _ - @ +`, separated by `/`, up to 200 characters. No leading `/`, no `.` or `..` parts, no hidden files. `index.html` is taken by `html`. |
| `content` | The file itself: text as is, binary files in base64 |
| `encoding` | `utf8` (the default) or `base64`. Images, fonts, audio, video and WebAssembly must be `base64`. |

Allowed types, by extension: `html`, `htm`, `css`, `js`, `mjs`, `json`, `map`, `txt`, `md`, `csv`, `xml`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `ico`, `woff`, `woff2`, `ttf`, `otf`, `mp3`, `wav`, `ogg`, `mp4`, `webm`, `wasm`. Each is served with its own content type, never guessed from the content.

A version is always a complete set: when the agent publishes a new version, it sends every file again. Files it leaves out are not carried over (older versions keep theirs).

Invalid files are rejected with a message the agent can act on, and nothing is published.

New pages are restricted in a personal workspace and visible to the organization in an organization workspace.

### list_artifacts

Lists the most recently updated pages in the connected workspace, with their ids and links.

### get_artifact

Returns the current version of a page, so the agent can edit it and publish a new version: its title, version number, the list of its files with their sizes, and the entry HTML. With `path` (for example `css/site.css`) it returns that one file instead, as text or, for binary files, as base64.

### rename_artifact

Changes a page's title without publishing a new version. The same rules as renaming in the app apply: editors only, 1 to 200 characters, spaces around it are trimmed.

### set_artifact_visibility

Changes who can open a page without publishing a new version.

### share_artifact

Shares a page with people by email, as `viewer` or `editor`, with an optional message. They get an email with the link.

## Updating a page

Ask for the change in the same conversation ("make the chart a line chart"). The agent reads the page with `get_artifact` (and any file it needs with `path`), edits it and publishes with the same `artifact_id` and the full set of files. The link stays the same, the version number goes up, and the old version stays in the [history](/docs/version-history).

## Managing pages in the app

In the gallery and the page viewer, the **…** menu lets editors rename a page and lets the owner delete it. Search above the gallery filters by title.
