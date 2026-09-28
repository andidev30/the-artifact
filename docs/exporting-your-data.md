# Exporting your data

You can download everything you have on The Artifact as one zip file: every page you own with its versions, sharing and comments, and your account. Owners of an organization can do the same for the whole organization. The files are plain HTML and JSON, so you can open them in a browser or an editor, or load them into another tool.

To download a single page instead, open it and choose **Download** in the **…** menu.

## Export your account

1. Open **Account settings** and go to **Export your data**.
2. Choose **Only the current version** or **Every version** of each page.
3. Select **Export data**.

The server builds the zip in the background. The section shows how many pages are done; keep the page open until it says **Your export is ready**. If the server sends email, you also get an email with a link back to settings. Then select **Download zip**.

The export has:

- Every page you own: in your personal workspace, and pages you published in organizations.
- Comments on those pages, and comments you wrote on other people's pages.
- Your account: your name and email, how you sign in, your organizations, connected agents, access tokens and sessions.

## Export an organization

Owners of an organization find **Export data** in the organization's settings (the gear next to it in the workspace menu). It works the same way and has every page in the organization, whoever published it, with its versions, sharing and comments, and the organization itself: its name and settings, its members with their names, email addresses and roles, pending invitations and folders. Admins and members don't see this section.

## What is in the zip

| Path | What it holds |
| --- | --- |
| `README.txt` | This layout, in short |
| `account.json` | Your account: name, email, when you joined, how you sign in (password, Google, passkeys, authenticator app, single sign-on), your organizations and roles, personal folders, connected agents, access tokens and sessions. An organization's export has `organization.json` instead: its name, address, settings, members, pending invitations and folders. |
| `comments.json` | Comments you wrote on other people's pages, with the page's address and title while you can still open it. Account exports only. |
| `pages/<page>/page.json` | The page: title, owner, workspace, folder, who can open it (general access, and whether its link expires or has a password), the people it is shared with and their roles, and every version with when it was published, by whom, with which agent, and how often it was opened |
| `pages/<page>/comments.json` | The comments on the page: text, the version it was written on, when it was written, edited or resolved, and the display name of its author (`null` when they have none or deleted their account). Replies name the comment they answer in `replyTo`. |
| `pages/<page>/versions/<n>/` | The files of version `n` as they were published. Open `index.html` in a browser to see the page. With **Only the current version**, only the current one is there, and `page.json` still lists them all. |

Each page's folder is named after its address, `{{APP_URL}}/a/<page>`. Times are in UTC.

The export never holds secrets: no passwords or their hashes, no values of access tokens or agent tokens, and no key or password of a shared link. Access tokens and agents are listed by name and date only.

## Download link and limits

- The download link works for 24 hours after the export is ready, and only for the person who asked for it, signed in. Anyone else who opens it gets "not found". Owners of an organization lose it if they stop being owners.
- After 24 hours the file is deleted; export again to get a new one.
- You can make one export of your account an hour, and one of each organization an hour. While one is being built, you can't start another. An export that fails doesn't count; try again.
- Deleting your account also deletes its exports.

## On a self-hosted server

The zip is built in the server's own storage bucket, under `exports/`, and deleted by the [storage sweep](/docs/self-hosting#where-content-is-stored) once it expires. The server builds it in the background even if the person closes the page, and picks it up again after a restart. When `S3_PUBLIC_ENDPOINT` is set, downloads come straight from the bucket through a link that works for 5 minutes; otherwise they pass through the server. On a host without a long-running server, like Vercel, the build moves on while someone has the settings page open, and `GET /api/cron/sweep` continues any left behind (see `CRON_SECRET` in [Configuration](/docs/configuration)). An operator changes the limit with the `data-export` [rate limit](/docs/configuration#rate-limits).
