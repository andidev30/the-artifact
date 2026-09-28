# @the-artifact/cli

Publish HTML pages to [The Artifact](https://github.com/andidev30/the-artifact) from a terminal or a CI job, without an agent. A folder with an `index.html` (and the CSS, JavaScript, images and data next to it) or a single HTML file becomes a page with a link you choose who can open.

Needs Node.js 20 or later. No dependencies.

```sh
npx @the-artifact/cli publish ./dist --server https://artifact.example.com
```

or install it once:

```sh
npm install -g @the-artifact/cli
the-artifact --help
```

## Sign in

```sh
the-artifact login --server https://artifact.example.com
```

opens your browser to sign in and pick the workspace to publish to. The sign-in is saved per server in `~/.config/the-artifact/credentials.json` (`%APPDATA%\the-artifact` on Windows), readable only by you, and the server becomes the default for later commands. It shows under **Account settings → Connected agents** as **The Artifact CLI**.

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
| `--save` | Remember the page in `.the-artifact.json`, so publishing the same path again publishes a new version |
| `--new` | Publish a new page even when `.the-artifact.json` has one for this path |
| `--dry-run` | List what would be sent, and send nothing |

## List and share

```sh
the-artifact list --query report
the-artifact share k3v9x2m8pq --visibility link
the-artifact share k3v9x2m8pq --email ana@example.com --role editor --message "Have a look"
```

## CI

Set `THE_ARTIFACT_URL` to the server and `THE_ARTIFACT_TOKEN` to an access token. Only the link goes to standard output, so it can be captured:

```yaml
- name: Publish the report
  env:
    THE_ARTIFACT_URL: https://artifact.example.com
    THE_ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}
  run: |
    url=$(npx @the-artifact/cli publish report --title "Test report" --id "${{ vars.REPORT_PAGE_ID }}")
    echo "Report: $url" >> "$GITHUB_STEP_SUMMARY"
```

Every command takes `--json` for scripts. A failed command prints the server's message and exits with `1`, or `2` for a wrong command line.

The full reference is in the docs: [Command line](https://github.com/andidev30/the-artifact/blob/main/docs/publishing.md#command-line).

## License

AGPL-3.0-only
