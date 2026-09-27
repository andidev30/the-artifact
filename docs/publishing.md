# Publishing pages

Agents publish through the MCP tools below. You don't call them yourself: ask the agent in plain words and it picks the right one.

## What makes a good page

- **One HTML document, or a small site.** A single self-contained document (inline CSS and JavaScript) is simplest. When a page is easier to build from several files, the agent sends the HTML as the entry plus its CSS, JavaScript, images, fonts and data, referenced by relative paths like `css/site.css` or `img/logo.png`. Scripts and fonts from public CDNs load fine either way.
- **Small.** The HTML can be up to 2 MB, each other file up to 5 MB, and all of it together up to 10 MB in at most 100 files. Compress images, or load large media from a URL.
- **On the hosted service's free Personal plan**, a personal workspace holds up to 50 pages. New versions of a page don't count, so when you reach the limit, update a page you have or delete one you no longer need. Pages in an organization don't count either.
- **A short title.** It shows in the gallery and the browser tab (up to 200 characters).

Pages run in a sandboxed frame: scripts, forms, pop-ups and downloads work, but a page can't read cookies, use `localStorage` on the app's origin, or talk to the rest of The Artifact. Its own files load normally, including with `fetch()`.

The gallery shows a screenshot of each page, taken on the server a few seconds after it is published (see [Security](/docs/security) for how). Until it exists, a card shows a sketch. Pages shared with **Anyone with the link** also use it in [link previews](/docs/sharing#link-previews).

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

### prepare_upload and publish_upload

Publish a page in two steps, with the files going straight to storage. Available when the server has `S3_PUBLIC_ENDPOINT` set (see [Configuration](/docs/configuration#object-storage)). See [Publishing by direct upload](#publishing-by-direct-upload).

`prepare_upload` takes `files`: every file of the page, **`index.html` included**, each as:

| Field | Meaning |
| --- | --- |
| `path` | `index.html` for the page itself, or the path the HTML uses for the file, with the same rules as above |
| `size` | Size in bytes |
| `sha256` | SHA-256 of the file's bytes, as 64 hex characters |

It answers with an `upload_id` and a link for each file that isn't stored yet. The agent sends each file's bytes to its link with an HTTP `PUT` within 15 minutes, then calls `publish_upload`:

| Argument | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Title for the gallery and tab |
| `upload_id` | yes | From `prepare_upload` |
| `files` | yes | The same list as for `prepare_upload` |
| `artifact_id` | no | Id or link of an existing page. Publishes a new version at the same link. |
| `visibility` | no | As for `publish_artifact` |

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

### delete_artifact

Deletes a page, like **Delete** in the app: the link stops working for everyone and every version is deleted. It can't be undone. Only the page's owner can delete it; editors and organization admins can't.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |

### list_versions

Lists every version of a page, newest first, as the [version history](/docs/version-history) shows them: when each was published, by whom, with which agent, and which version a restore came from. Editors only.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |

### restore_version

Makes an older version current again, like **Restore this version** in the history: its HTML and files are published again as a new version, and the link stays the same. Editors only.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `version` | yes | The version number to restore, from `list_versions` |

### download_artifact

Returns a link that downloads a version of a page as a zip: `index.html` and every file, at the paths the page uses. The agent fetches it itself, for example with `curl`, so this is for agents that can run shell commands or make HTTP requests; others read the files one at a time with `get_artifact`.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `version` | no | A version number from `list_versions`. Without it, the current version. Older versions are for editors only. |

The link needs no sign-in, but it only works for the person the agent is connected as, for that version, and for 12 hours. Access is checked again each time it is used, so it stops working if that person loses access to the page.

## Publishing by direct upload

With `publish_artifact`, a page travels inside the MCP call, so it is limited by what the agent and the server can send in one request. Hosts like Vercel refuse requests over about 4.5 MB. Agents that can run shell commands or make HTTP requests (Claude Code, Cursor, Codex and other coding agents) can use `prepare_upload` and `publish_upload` instead, and the files go straight to storage:

1. The agent lists the files with their sizes and hashes. The server checks them against the same rules and limits as above, and nothing is published yet.
2. The agent uploads each file to its link, for example with `curl -T`.
3. On `publish_upload`, the server hashes every uploaded file itself. A file that is missing, or whose bytes don't match its size and hash, stops the publish with a message, and nothing is published.

Files whose content is already stored, like the images of a page you publish a new version of, need no upload. Uploads that are never published are deleted after an hour.

Agents that can't make requests of their own keep using `publish_artifact`.

## Updating a page

Ask for the change in the same conversation ("make the chart a line chart"). The agent reads the page with `get_artifact` (and any file it needs with `path`), edits it and publishes with the same `artifact_id` and the full set of files. The link stays the same, the version number goes up, and the old version stays in the [history](/docs/version-history).

## Managing pages in the app

In the gallery and the page viewer, the **…** menu lets anyone who can open a page **Download** it as a zip of `index.html` and its files, lets editors rename it and lets the owner delete it. In the viewer, **Download** saves the version you are looking at, including an older one picked in the history. Search above the gallery filters by title.
