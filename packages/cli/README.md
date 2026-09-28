# @the-artifact/cli

Publish HTML pages to [The Artifact](https://github.com/andidev30/the-artifact) from a terminal or a CI job, without an agent. A folder with an `index.html` (and the CSS, JavaScript, images and data next to it) or a single HTML file becomes a page with a link you choose who can open.

Needs Node.js 20 or later. No dependencies.

```sh
npx @the-artifact/cli login
npx @the-artifact/cli publish ./dist
```

Commands go to the hosted service, https://the-artifact-pi.vercel.app, unless you name another server. For a self-hosted install, pass `--server https://your-server` once to `login`; later commands use the server you signed in to.

or install it once:

```sh
npm install -g @the-artifact/cli
the-artifact --help
```

## Sign in

```sh
the-artifact login
```

opens your browser to sign in and pick the workspace to publish to. Add `--server https://your-server` to sign in to a self-hosted install instead of the hosted service. The sign-in is saved per server in `~/.config/the-artifact/credentials.json` (`%APPDATA%\the-artifact` on Windows), readable only by you, and the server becomes the default for later commands. It shows under **Account settings → Connected agents** as **The Artifact CLI**.

On a machine without a browser, create an access token in **Account settings → Access tokens** and save it:

```sh
the-artifact login --with-token < token.txt
```

`the-artifact whoami` shows who you're signed in as, and `the-artifact logout` signs out and disconnects the CLI on the server.

## Publish

```sh
the-artifact publish ./dist
```

prints the page's link. Hidden files and folders, `node_modules`, and file types pages can't hold are left out, with a note for each.

| Option | Meaning |
| --- | --- |
| `--title <title>` | The page's title. By default the HTML's `<title>`, or the folder's name. |
| `--id <page>` | Publish a new version of this page, by its id or link |
| `--entry <path>` | The HTML file in the folder that is the page, instead of `index.html` |
| `--visibility <who>` | `restricted`, `organization` or `link` |
| `--folder <name>` | File the page into this folder of the workspace |
| `--ignore <glob>` | Leave out matching files, like `'*.map'`; repeat for more |
| `--only <path>` | Send only this file (or glob) and keep the page's other files as they are; repeat for more |
| `--remove <path>` | Remove this file from the page and keep the others; repeat for more |
| `--save` | Remember the page in `.the-artifact.json`, so publishing the same path again publishes a new version |
| `--new` | Publish a new page even when `.the-artifact.json` has one for this path |
| `--dry-run` | List what would be sent, and send nothing |

### Updating some files

A dashboard whose data a job refreshes doesn't need to send the whole page again. With `--only`, `publish` sends just the files you name and keeps every other file of the page's current version:

```sh
the-artifact publish ./dashboard --id k3v9x2m8pq --only data.json
```

`--only` takes paths relative to the folder or globs like `'data/*.json'`, and the folder needn't hold the rest of the page. `--remove old.css` removes a file. Both need the page, with `--id` or a page saved with `--save`, and the title stays as it is unless you pass `--title`. Each run is a new version in the page's history, with the same limits.

A cron job refreshing a dashboard every hour:

```sh
# crontab: 0 * * * * /opt/dashboard/refresh.sh
set -e
cd /opt/dashboard
./export-metrics > site/data.json
THE_ARTIFACT_TOKEN=$(cat token.txt) npx @the-artifact/cli publish site --id k3v9x2m8pq --only data.json
```

## List and share

```sh
the-artifact list --query report
the-artifact share k3v9x2m8pq --visibility link
the-artifact share k3v9x2m8pq --expires 2026-12-31 --password "open sesame"
the-artifact share k3v9x2m8pq --new-link
the-artifact share k3v9x2m8pq --email ana@example.com --role editor --message "Have a look"
```

## CI

Set `THE_ARTIFACT_URL` to the server and `THE_ARTIFACT_TOKEN` to an access token. Only the link goes to standard output, so it can be captured:

```yaml
- name: Publish the report
  env:
    THE_ARTIFACT_URL: https://the-artifact-pi.vercel.app
    THE_ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}
  run: |
    url=$(npx @the-artifact/cli publish report --title "Test report" --id "${{ vars.REPORT_PAGE_ID }}")
    echo "Report: $url" >> "$GITHUB_STEP_SUMMARY"
```

Every command takes `--json` for scripts. A failed command prints the server's message and exits with `1`, or `2` for a wrong command line.

The full reference is in the docs: [Command line](https://github.com/andidev30/the-artifact/blob/main/docs/publishing.md#command-line).

## License

AGPL-3.0-only
