# Sharing and permissions

Sharing works like a Google Doc. Open a page and choose **Share**.

## People with access

Add people by email as **Viewer** or **Editor**. They get an email with the link. People who don't have an account yet get access as soon as they sign up with that email address.

Until the share counts for someone, the list shows them as "invited, not signed in yet", without a name. Names come from the person's account once it does, so a name you see was never chosen by someone who only typed the address.

### People who aren't emailed

When you turn off **Notify people by email**, when the server doesn't send email, or when an email can't be sent, **Share** lists a link for each person under **Links to send**. Send each person their own link however you like. It opens the page once they sign in with that address, and it works once. Sharing with the same address again gives a new link, and the earlier one stops working. An address that got 10 invitation and share emails in a day, from everyone together, isn't emailed again that day; its link is listed instead (the `invite-recipient` [rate limit](/docs/configuration#rate-limits)).

### Addresses nobody has checked

A share goes to an email address, so it counts for an account only once that account has shown the address is really theirs: by signing in with an email link, an admin's sign-in link, Google or single sign-on. On a [server without email](/docs/self-hosting#running-without-email), people who sign up with a password on their own, or from an invitation link, typed their address and nobody checked it. Someone could have signed up with a colleague's address before anything was shared with it. So for those accounts, a share counts only after they open its link from **Links to send**, signed in with that address. Until then the page looks as if it weren't shared with them, and it isn't in their **Shared with you**. Once they sign in in one of the ways above, every share with their address counts.

Adding and removing people is [rate limited](/docs/configuration#rate-limits) per account (`invite`, whether or not anyone is emailed, and `unshare`), so the list can't be used to find out which addresses have an account.

| Role | Can |
| --- | --- |
| Viewer | Open the page |
| Editor | Open it, publish new versions, rename it, restore old versions, and change who has access |
| Owner | Everything an editor can, and delete the page |

## General access

Who can open the page with just the link:

- **Restricted**: only the owner and the people added above
- **Your organization**: everyone in the organization the page belongs to (organization pages only)
- **Anyone with the link**: no account needed

## Link expiry, password and reset

When a page is set to **Anyone with the link**, **Share** shows three more options under it:

- **Link expires**: **Never**, the default, keeps the link working until you change it. **On a date** asks for the last day it works; after the end of that day, the link opens nothing.
- **Link password**: people who open the link enter it first, on a small password page, before they see anything of the page. It needs at least 8 characters. Your browser remembers it for that page for 12 hours. **Remove password** takes it off.
- **Reset link**: the page gets a new public link, `{{APP_URL}}/a/<page id>?k=<key>`. Every public link shared before stops working. **Copy link** and the embed code give the new one.

Above the options, a line says what the link does now, for example "The link never expires." or "The link works until 31 December 2026. People who open it enter a password." **Save link settings** applies the expiry and password together.

These only change what the link does for people with no access of their own. The owner, the people added above and, for **Your organization** pages, the organization's members keep opening the page at its own address, `{{APP_URL}}/a/<page id>`: no key, no password and no expiry. A reset never changes that address, so the links in sharing emails keep working.

Until you reset it for the first time, a page's public link is its own address, as it was before keys existed, so links you already shared keep working. After the first reset, the plain address only opens the page for people with access of their own.

An expired link, and a public link from before a reset, behave exactly like a page that doesn't exist: "This page isn't available", and nothing in link previews or embeds.

Changing the password asks everyone for the new one, including people who entered the old one. Too many wrong passwords for one page, from anywhere, pause new tries for a while (the `link-password` [rate limit](/docs/configuration#rate-limits)).

Agents do the same with `set_artifact_visibility`:

| Argument | Meaning |
| --- | --- |
| `visibility` | `private` (restricted), `organization` or `link`. Leave it out to keep it as it is. |
| `link_expires` | A date (`2026-12-31`, the end of that day in UTC) or an ISO 8601 date and time. An empty string or `never` removes the expiry. |
| `link_password` | The password, at least 8 characters. An empty string removes it. |
| `rotate_link` | `true` resets the public link. The answer has the new one as `Public link`. The page keeps its id. |

The CLI has `--expires`, `--password` and `--new-link` on `the-artifact share` (see [Publishing](/docs/publishing#listing-and-sharing)).

## Organization admins

In an organization, owners and admins can edit every page in it, even pages that are restricted to other people.

## Who sees what

| | Restricted | Organization | Anyone with the link |
| --- | --- | --- | --- |
| Owner | Edit | Edit | Edit |
| Invited editor | Edit | Edit | Edit |
| Invited viewer | View | View | View |
| Organization owner or admin | Edit | Edit | Edit |
| Organization member | – | View | View |
| Anyone else, signed in or not | – | – | View, until the link expires, with its password if it has one |

The owner of a page in an organization counts as its owner only while they are a member of it. After they leave or are removed, or while the organization [requires two-factor sign-in](/docs/organizations#requiring-two-factor-sign-in) they haven't set up, they are in the row that applies to them otherwise: usually an invited viewer or editor, or anyone else.

An agent or access token counts the owner row and the organization rows only for pages in the workspace it was connected to; elsewhere it gets the invited and link rows (see [Choosing a workspace](/docs/connect-your-agent#choosing-a-workspace)).

When someone can't open a page, they see "This page isn't available", whether the page is private or doesn't exist. That way a link doesn't reveal that a private page exists.

Everyone in the table who can open a page can also read and write its [comments](/docs/comments) once signed in. Visitors who aren't signed in don't see comments, even on a page shared with **Anyone with the link**.

## Who opened a page

Open a page and choose **Views** to see how many times it was opened, in all and for each version, and who opened it. **Views** is there for the people who can edit the page (its owner, invited editors, and organization owners and admins); people who can only view it don't see it, and pages in the gallery don't show views.

What is recorded:

| Visit | Recorded | Kept |
| --- | --- | --- |
| Someone opens a **Restricted** or **Your organization** page: people it was shared with by email, and members of the organization | One more view of that version, plus who (their account) and when | The count for as long as the page exists; who and when for 90 days |
| Anyone opens a page set to **Anyone with the link**, signed in or not | One more view of that version, nothing about who | For as long as the page exists |
| An editor opens an older version from **History** | One more view of that version, plus who and when | As above |
| The page's owner opens their own page | Nothing | |

- A view is counted when a browser opens the page itself, in the app or in an [embed](#embedding). Agents reading a page with `get_artifact`, downloads, link previews and screenshots don't count.
- Repeat visits by the same person to the same version within 30 minutes count once. For visits through the link, the server tells visitors apart by their network address and browser, in memory only; neither is stored.
- On a server that keeps running (the Docker image, Kubernetes, `node dist/index.js`), counts are added up in memory and written every 5 seconds, so they can lag a few seconds behind, and a crash can lose the last few seconds of counts. Stopping the server normally writes them first. Who opened a page is written straight away. On hosts without a long-running server, like Vercel, each view is written as it happens.
- After 90 days, the record of who opened a page and when is deleted. The counts stay. Deleting your account deletes the records of what you opened; deleting a page deletes its views.
- **Views** lists each person once, with when they last opened the page, which version, and how many times in the last 90 days.

Agents can read the same numbers with `list_views` (see [Publishing](/docs/publishing#list_views)).

## Link previews

When you paste a page's link into Slack, WhatsApp, an email or anything else that shows previews, a page set to **Anyone with the link** shows its title and its screenshot. Without a screenshot (it is still being taken, or the server doesn't take them), the preview shows the title only.

**Restricted** and **Your organization** pages, links with a password or past their expiry, public links from before a reset, and links to pages that don't exist, all preview as plain "The Artifact". The service that builds the preview isn't signed in, so it learns nothing about the page, not even that it exists. If you switch a page from **Anyone with the link** back to **Restricted**, new previews stop showing it, but apps that already fetched one may keep showing what they saw.

## Embedding

A page set to **Anyone with the link** can be embedded in Notion, Confluence, a wiki or any site that takes an `<iframe>`. The embed shows the page itself, without the app around it, with a small **Open in The Artifact** link underneath. It always shows the current version.

- **Notion:** paste the page's link and choose **Embed**. Notion finds the embed through the page's [oEmbed](https://oembed.com) tag.
- **Confluence:** add an **iframe** or **Embed** macro (depending on your Confluence) and give it the page's link, or the embed address below.
- **Anywhere else:** open **Share**, and under **Embed** copy the code. It looks like this:

```html
<iframe src="{{APP_URL}}/e/<page id>" width="100%" height="600" style="border:0" title="Signups by week" loading="lazy" allowfullscreen></iframe>
```

Once the link was [reset](#link-expiry-password-and-reset), the embed address carries its key, `{{APP_URL}}/e/<page id>?k=<key>`, and embeds of an earlier address show the sign-in card. A link with a password can't be embedded.

The page runs in the same sandbox as in the app: its scripts work, but they can't reach the site it is embedded in or your account.

An embed never uses your sign-in, even if you are signed in: the site it sits on shows the same thing to everyone who opens it. So a **Restricted** or **Your organization** page, a link with a password or past its expiry, or a link to a page that doesn't exist, shows the same "Sign in to view this page" card, with a link to open the page in The Artifact. The card never shows the page's title, content or screenshot. If you switch a page from **Anyone with the link** back to **Restricted**, its embeds show the card the next time they load.

Tools that embed by link ask `{{APP_URL}}/api/oembed?url=<page link>` for the embed code. It answers only for pages shared with **Anyone with the link**, with no password and not expired; for every other page it answers "not found", as if the page didn't exist.

If your server is only reachable on a private network, browsers such as Chrome ask each person before a public site like Notion may show its embeds, or refuse.

A server admin can limit which sites may embed pages with `EMBED_FRAME_ANCESTORS` (see the [configuration reference](/docs/configuration)). The app itself, including `/a/<page id>`, can't be framed by other sites.

## Duplicating a page

**Duplicate** in a page's **…** menu, in the gallery or the viewer, makes a new page from what the page shows now. Anyone signed in who can open the page can duplicate it, into their personal workspace or an organization they are a member of. Agents do the same with `duplicate_artifact`.

- **Only the current version is copied.** The copy starts at version 1, and older versions stay with the original.
- **The copy is yours** and has its own link. It starts **Restricted**: nobody else is added, it has no link expiry, password or public link, and no comments or views. Share it as you would a new page.
- **Its name** is the page's name with " (copy)" after it, unless you change it in the dialog.
- It counts as a new page in the workspace it goes to, toward its [quota](/docs/configuration#workspace-quotas) and the `publish` [rate limit](/docs/configuration#rate-limits). The content itself is stored once, however many copies there are.

## Moving a page to another workspace

**Move to workspace** in a page's **…** menu moves it between your personal workspace and an organization, or from one organization to another. Agents do the same with `move_artifact` and its `workspace` argument.

Who can move a page:

- **You need edit access to the page and a place in the workspace it is in now**: owners, and in an organization its owners and admins and editors who are members. People it is only shared with can't move it out of someone else's workspace.
- **You need to be able to publish in the workspace it goes to**: your personal workspace, or an organization you are a member of. An organization that [requires two-factor sign-in](/docs/organizations#requiring-two-factor-sign-in) takes pages only from members who have it.
- **Personal pages are their owner's.** Only the owner moves a page out of their personal workspace, and only the owner moves a page into Personal: it goes to their own.

What happens to the page:

| | After the move |
| --- | --- |
| Link and page id | The same. Links already shared keep working. |
| Owner, versions and history | The same |
| People it is shared with | Kept, with their roles |
| Link expiry, password and public link | Kept |
| Comments and views | Kept |
| Folder | Cleared: folders belong to one workspace. File it again in the new one. |
| **Your organization** access | Becomes **Restricted** when the page moves to a personal workspace. Moved to another organization, it is open to that organization instead. |

From then on, the new workspace's rules apply: its members and admins get the access its general access gives them and members of the old organization lose theirs, and its [version retention](/docs/retention) and quota count the page and all its versions. A move is refused when the page wouldn't fit in the new workspace's quota. On the hosted service, the free Personal plan's limits apply to pages moved into Personal, and it removes versions older than 7 days as it does for every personal page.

With an [audit log](/docs/audit-log), the organization the page leaves records **Moved a page out of the organization** and the one it arrives in records **Moved a page into the organization**.

## Pages shared with you

The **Shared with you** tab in the gallery lists pages other people shared with your email address, with your role. It shows no [folders](/docs/publishing#folders): those belong to the workspace the page is in, so you don't see how its owner sorts their pages.
