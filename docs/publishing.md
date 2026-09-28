# Publishing pages

Agents publish through the MCP tools below. You don't call them yourself: ask the agent in plain words and it picks the right one.

## What makes a good page

- **One HTML document, or a small site.** A single self-contained document (inline CSS and JavaScript) is simplest. When a page is easier to build from several files, the agent sends the HTML as the entry plus its CSS, JavaScript, images, fonts and data, referenced by relative paths like `css/site.css` or `img/logo.png`. Scripts and fonts from public CDNs load fine either way.
- **Small.** The HTML can be up to 2 MB, each other file up to 5 MB, and all of it together up to 10 MB in at most 100 files. Compress images, or load large media from a URL.
- **On the hosted service's free Personal plan**, a personal workspace holds up to 50 pages and 1 GB of storage. New versions of a page don't count toward the 50, so when you reach it, update a page you have or delete one you no longer need. Pages in an organization don't count either. See [Limits](#limits).
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
| `folder` | no | Name of a [folder](#folders) in the connected workspace, up to 80 characters. It is created if there is none by that name. An empty string takes the page out of its folder. Left out, a new page goes in no folder and an existing one stays where it is. |

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
| `folder` | no | As for `publish_artifact` |

### list_artifacts

Lists the pages in the connected workspace, most recently updated first, with their ids, links and folders. It answers 25 at a time; when there are more, the answer ends with a `cursor` the agent passes back for the next ones. The same list also comes as structured content, for scripts: `{ pages: [{ id, title, url, version, visibility, folder, updated_at }], total, cursor }`, where `total` is only counted on the first batch and `cursor` is `null` when there are no more.

| Argument | Required | Meaning |
| --- | --- | --- |
| `query` | no | Only pages whose title contains this, ignoring case |
| `folder` | no | Only pages in the folder with this name; an empty string for pages in no folder |
| `limit` | no | How many to list, 1 to 100. 25 by default. |
| `cursor` | no | From the end of the previous answer, for the next pages |

### list_folders

Lists the folders of the connected workspace, by name, with how many of the pages you can see are in each. It takes no arguments.

### move_artifact

Files a page into a folder of the connected workspace, or takes it out of its folder, without publishing a new version. For people who can edit the page, from the workspace the page is in. The link and who can open the page stay the same.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `folder` | yes | Folder name, created if there is none by that name, or an empty string to take the page out of its folder |

### get_artifact

Returns the current version of a page, so the agent can edit it and publish a new version: its title, version number, the list of its files with their sizes, and the entry HTML. With `path` (for example `css/site.css`) it returns that one file instead, as text or, for binary files, as base64.

### rename_artifact

Changes a page's title without publishing a new version. The same rules as renaming in the app apply: editors only, 1 to 200 characters, spaces around it are trimmed.

### set_artifact_visibility

Changes who can open a page without publishing a new version, and sets up its public link: when it expires, a password, or a reset that replaces it. For people who can edit the page. Pass at least one argument besides `artifact_id`.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `visibility` | no | `private` (restricted), `organization` or `link` |
| `link_expires` | no | When the link stops working for people with no access of their own: a date (`2026-12-31`, the end of that day in UTC) or an ISO 8601 date and time. An empty string or `never` removes it. |
| `link_password` | no | A password people enter to open the page by its link, at least 8 characters. An empty string removes it. |
| `rotate_link` | no | `true` resets the public link: public links shared before then work like a page that doesn't exist. The page keeps its id and its own link, which people with access keep using. |

When the page is shared by link, the answer ends with its `Public link`, to hand to people without access of their own; `Link` is the page's own address. The expiry, the password and the key only apply while `visibility` is `link`. See [Link expiry, password and reset](/docs/sharing#link-expiry-password-and-reset).

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

### list_views

How many times each version of a page was opened, and who opened it in the last 90 days with when they last did, like **Views** in the app. Visits through a link shared with **Anyone with the link** are counted but anonymous. Editors only. See [Who opened a page](/docs/sharing#who-opened-a-page) for what is recorded.

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

### list_comments

Reads the [comments](/docs/comments) on a page: threads oldest first, each with its replies, the author, the agent it was posted through (if any) and the version that was current when it was written. Resolved threads are left out unless `include_resolved` is set. For anyone who can open the page. Agents are told to read comments before publishing a new version, and `get_artifact` says how many threads are open.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `include_resolved` | no | `true` to list resolved threads too |
| `limit` | no | How many threads, 1 to 100; 50 when left out |
| `cursor` | no | The cursor from the end of the previous answer, for the next threads |

### add_comment

Starts a new comment thread on a page, for example to say what a new version changed. The comment is posted as the person the agent is connected as, marked with the agent's name.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `body` | yes | Plain text, up to 5,000 characters |

### reply_comment

Replies in the thread of a comment, as the connected person, marked with the agent's name. Replying to a reply adds to the same thread, and a reply reopens a resolved thread.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `comment_id` | yes | A `comment_id` from `list_comments` |
| `body` | yes | Plain text, up to 5,000 characters |

### resolve_comment

Resolves the thread of a comment, or reopens it. For the person who started the thread and people who can edit the page.

| Argument | Required | Meaning |
| --- | --- | --- |
| `artifact_id` | yes | Id or link of the page |
| `comment_id` | yes | A `comment_id` from `list_comments`; a reply's id resolves its thread |
| `resolved` | no | `false` reopens the thread; `true` when left out |

## Publishing by direct upload

With `publish_artifact`, a page travels inside the MCP call, so it is limited by what the agent and the server can send in one request. Hosts like Vercel refuse requests over about 4.5 MB. Agents that can run shell commands or make HTTP requests (Claude Code, Cursor, Codex and other coding agents) can use `prepare_upload` and `publish_upload` instead, and the files go straight to storage:

1. The agent lists the files with their sizes and hashes. The server checks them against the same rules and limits as above, and nothing is published yet.
2. The agent uploads each file to its link, for example with `curl -T`.
3. On `publish_upload`, the server hashes every uploaded file itself. A file that is missing, or whose bytes don't match its size and hash, stops the publish with a message, and nothing is published.

Files whose content is already stored, like the images of a page you publish a new version of, need no upload. Uploads that are never published are deleted after an hour.

Agents that can't make requests of their own keep using `publish_artifact`.

## Command line

The `the-artifact` command publishes a folder or an HTML file from a terminal or a CI job, without an agent. It needs Node.js 20 or later:

```sh
npx @the-artifact/cli publish ./dist --server {{APP_URL}}
```

or installed once with `npm install -g @the-artifact/cli`, then run as `the-artifact`.

### Signing in

```sh
the-artifact login --server {{APP_URL}}
```

opens your browser at the same sign-in and workspace choice as [connecting an agent](/docs/connect-your-agent#choosing-a-workspace). The CLI then shows under **Account settings → Connected agents** as **The Artifact CLI**, and pages it publishes are marked with that name in the [history](/docs/version-history). The server you sign in to becomes the default, so later commands don't need `--server`. With no `--server`, no `THE_ARTIFACT_URL` and no sign-in, the CLI uses the hosted service, https://the-artifact-pi.vercel.app.

| Command | What it does |
| --- | --- |
| `the-artifact login` | Signs in with the browser. `--no-browser` prints the link instead of opening it. |
| `the-artifact login --with-token < token.txt` | Saves an [access token](/docs/connect-your-agent#publishing-from-ci) read from standard input instead, for a machine with no browser. |
| `the-artifact whoami` | Shows the account and workspace the CLI publishes to, and checks the sign-in still works |
| `the-artifact logout` | Removes the saved sign-in and disconnects it on the server |

Sign-ins are saved per server in `~/.config/the-artifact/credentials.json` (`%APPDATA%\the-artifact` on Windows, `$XDG_CONFIG_HOME/the-artifact` when that is set), readable only by you. Signing in over SSH needs a browser on the same machine; on a server, use `--with-token` or `THE_ARTIFACT_TOKEN`.

### Publishing

```sh
the-artifact publish ./dist
```

publishes `dist/index.html` as the page and every other file in the folder next to it, then prints the link. Hidden files and folders, `node_modules`, and files of types pages can't hold are left out, with a note for each. A single file works too: `the-artifact publish report.html`. The [size limits](#what-makes-a-good-page) are checked before anything is sent.

| Option | Meaning |
| --- | --- |
| `--title <title>` | The page's title. By default the HTML's `<title>`, or the folder's name. |
| `--id <page>` | Publish a new version of this page, by its id or link. Empty, it publishes a new page. |
| `--entry <path>` | The HTML file in the folder that is the page, instead of `index.html` |
| `--visibility <who>` | `restricted`, `organization` or `link` |
| `--folder <name>` | File the page into this [folder](#folders); `""` takes it out |
| `--ignore <glob>` | Leave out matching files, like `'*.map'` or `drafts/`; repeat for more. A pattern without a `/` matches names at any depth. |
| `--save` | Remember the page in `.the-artifact.json` in the current folder, so publishing the same path again publishes a new version of it. Commit the file to share it. |
| `--new` | Publish a new page even when `.the-artifact.json` has one for this path |
| `--dry-run` | List what would be sent, and send nothing |

The link is the only thing printed on standard output, so `url=$(the-artifact publish dist)` captures it. Progress and notes go to standard error.

### Listing and sharing

| Command | What it does |
| --- | --- |
| `the-artifact list` | Lists the pages in the workspace, newest first: id, version, who can open it, folder and title. `--query <words>` searches titles, `--folder <name>` narrows to a folder, `--limit <n>` (1 to 100) and `--cursor` page through. |
| `the-artifact share <page> --visibility link` | Changes who can open a page: `restricted`, `organization` or `link` |
| `the-artifact share <page> --expires 2026-12-31 --password <text>` | The link stops working after that day (UTC), and asks for the password. `--expires never` and `--password ""` remove them. |
| `the-artifact share <page> --new-link` | Resets the public link and prints the new one; public links shared before stop working. The page keeps its id. |
| `the-artifact share <page> --email ana@example.com` | Shares a page with people by email; repeat `--email` for more. `--role editor` lets them publish new versions too, and `--message` adds a note to the email. |

### In CI

Set `THE_ARTIFACT_TOKEN` to an [access token](/docs/connect-your-agent#publishing-from-ci) and `THE_ARTIFACT_URL` to `{{APP_URL}}`, and every command uses them instead of a saved sign-in:

```yaml
- name: Publish the report
  env:
    THE_ARTIFACT_URL: {{APP_URL}}
    THE_ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}
  run: npx @the-artifact/cli publish report --title "Test report" --id "${{ vars.REPORT_PAGE_ID }}"
```

`--token <token>` works too, but a token on the command line can end up in shell history and process lists.

| Setting | Meaning |
| --- | --- |
| `THE_ARTIFACT_URL` | The server, like `--server` |
| `THE_ARTIFACT_TOKEN` | An access token, like `--token`. It takes precedence over a saved sign-in. |
| `THE_ARTIFACT_CONFIG_DIR` | Where sign-ins are saved, instead of the folder above |

Every command takes `--json` to print JSON for scripts: `publish` prints the same answer as [`POST /api/publish`](#publishing-without-an-agent), and `list` prints `{ "pages": [...], "total", "cursor" }`. A command that fails prints the server's message and exits with `1`, or `2` when the command line itself is wrong.

## Publishing without an agent

CI jobs and scripts publish with a plain HTTP request to `POST {{APP_URL}}/api/publish`, authorized by an [access token](/docs/connect-your-agent#publishing-from-ci) as `Authorization: Bearer art_…`. It takes the same things as `publish_artifact`, publishes to the token's workspace with the same rules, limits and quotas, and answers with the link. The endpoint is stable: scripts and tools can rely on it.

Send either JSON (`Content-Type: application/json`) with the fields of [publish_artifact](#publish_artifact):

```json
{
  "title": "Nightly dashboard",
  "html": "<!doctype html>…",
  "files": [{ "path": "chart.js", "content": "…" }, { "path": "img/logo.png", "content": "iVBORw0…", "encoding": "base64" }],
  "artifact_id": "k3v9x2m8pq",
  "visibility": "organization",
  "folder": "Reports"
}
```

or multipart form data, which is easier from a shell because files go up as they are:

| Part | Meaning |
| --- | --- |
| `title`, `artifact_id`, `visibility`, `folder` | Text fields, as in `publish_artifact` |
| `index.html` | The page itself, as a file or text |
| Any other name | A file of the page, named by its path: `css/site.css`, `img/logo.png` |

```sh
curl -fsS {{APP_URL}}/api/publish -H "Authorization: Bearer $ARTIFACT_TOKEN" \
  -F 'title=Test report' -F 'index.html=@report/index.html' -F 'css/site.css=@report/css/site.css'
```

A new page answers `201`, a new version (with `artifact_id`) `200`, both with:

```json
{
  "id": "k3v9x2m8pq",
  "url": "{{APP_URL}}/a/k3v9x2m8pq",
  "title": "Test report",
  "version": 1,
  "visibility": "private",
  "folder": null
}
```

Errors are JSON `{ "error": "…" }` with a message to show as is, sometimes with the `field` it is about: `400` for a page that can't be published (a bad file, a full workspace, an `artifact_id` you can't edit), `401` for a missing, expired or revoked token, `413` for a request over the size limit, `415` for another content type, and `429` with `Retry-After` past the `publish` [rate limit](/docs/configuration#rate-limits). Hosts like Vercel refuse requests over about 4.5 MB before they reach the server; for larger pages, run an agent with the token and use [direct upload](#publishing-by-direct-upload). The [command line](#command-line) sends pages the same way, so the same limit applies to it.

To check a token before relying on it, `GET {{APP_URL}}/api/whoami` with it as the bearer token answers with whom it acts for and where it publishes, or `401` like above:

```json
{ "email": "ana@example.com", "name": "Ana", "workspace": { "id": null, "name": "Personal" }, "client": "GitHub Actions" }
```

`workspace.id` is the organization's id, or `null` for a personal workspace, and `client` is the token's name (or the agent's, for an agent's sign-in).

## Limits

Besides the size of each page, a server limits how fast an account uses these tools and how much a workspace holds. Past a limit, the tool answers with an error that says so and what to do, and the agent tells you.

| Limit | Default |
| --- | --- |
| Tool calls, by every agent of one account together | 600 per 10 minutes |
| New pages and versions (`publish_artifact`, `publish_upload`, `restore_version`, `POST /api/publish`) | 200 per hour |
| People shared with by email (`share_artifact`, counted with invitations in the app) | 200 per hour |
| Comments and replies (`add_comment`, `reply_comment`, counted with comments in the app) | 120 per hour |
| Pages, versions and storage in a self-hosted workspace | None, unless the server sets them |
| A personal workspace on the hosted service's free Personal plan | 50 pages and 1 GB of storage; versions older than 7 days are removed |

A rate limit ends on its own: the message says how long to wait. For a full workspace, delete pages you no longer need in the gallery, or publish a new version of a page you have instead of a new page. Storage counts every version of every page in full, so a page with many large versions uses more. Self-hosted servers can change all of these; see [Rate limits](/docs/configuration#rate-limits) and [Workspace quotas](/docs/configuration#workspace-quotas).

## Updating a page

Ask for the change in the same conversation ("make the chart a line chart"), or point the agent at the page's comments ("deal with the open comments on the launch plan"). The agent reads the page with `get_artifact` (and any file it needs with `path`) and the feedback with `list_comments`, edits it and publishes with the same `artifact_id` and the full set of files. The link stays the same, the version number goes up, and the old version stays in the [history](/docs/version-history).

## Managing pages in the app

In the gallery and the page viewer, the **…** menu lets anyone who can open a page **Download** it as a zip of `index.html` and its files, lets editors rename it and lets the owner delete it. In the viewer, **Download** saves the version you are looking at, including an older one picked in the history.

The gallery shows the newest pages first and loads more as you scroll, so a workspace with thousands of pages opens as fast as one with ten. The search box above it filters by title, ignoring case, within the folder you are looking at.

## Folders

Folders group the pages of one workspace: your personal workspace, or an organization, where they are shared by everyone in it. They are one level deep, and each name is used once per workspace, whatever its case.

- **Folders never change who can open a page.** A restricted page in a folder stays restricted, and people only see the pages they could open anyway. Folder counts only count those.
- **Anyone who can publish in the workspace organizes its folders**: you in your personal workspace, and every member of an organization. They create folders with **New folder**, and pick one above the gallery to **Rename** it or **Delete folder**.
- **To file a page**, choose **Move to folder** in its **…** menu, or ask your agent (it uses `move_artifact`, or `folder` when it publishes). Filing a page takes edit access to it, and doesn't change when it was last updated.
- **Deleting a folder keeps its pages.** They stay in the workspace, in no folder.
- **Pages shared with you** from someone else's workspace show without their folder: folders belong to the workspace that owns the page. You file only the pages of your own workspaces.

Folders are the lighter answer to one company with several divisions: an [organization](/docs/organizations) can be a division, and folders sort pages within it.
