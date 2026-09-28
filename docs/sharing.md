# Sharing and permissions

Sharing works like a Google Doc. Open a page and choose **Share**.

## People with access

Add people by email as **Viewer** or **Editor**. They get an email with the link. People who don't have an account yet get access as soon as they sign up with that email address.

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
| Anyone else, signed in or not | – | – | View |

When someone can't open a page, they see "This page isn't available", whether the page is private or doesn't exist. That way a link doesn't reveal that a private page exists.

Everyone in the table who can open a page can also read and write its [comments](/docs/comments) once signed in. Visitors who aren't signed in don't see comments, even on a page shared with **Anyone with the link**.

## Link previews

When you paste a page's link into Slack, WhatsApp, an email or anything else that shows previews, a page set to **Anyone with the link** shows its title and its screenshot. Without a screenshot (it is still being taken, or the server doesn't take them), the preview shows the title only.

**Restricted** and **Your organization** pages, and links to pages that don't exist, all preview as plain "The Artifact". The service that builds the preview isn't signed in, so it learns nothing about the page, not even that it exists. If you switch a page from **Anyone with the link** back to **Restricted**, new previews stop showing it, but apps that already fetched one may keep showing what they saw.

## Embedding

A page set to **Anyone with the link** can be embedded in Notion, Confluence, a wiki or any site that takes an `<iframe>`. The embed shows the page itself, without the app around it, with a small **Open in The Artifact** link underneath. It always shows the current version.

- **Notion:** paste the page's link and choose **Embed**. Notion finds the embed through the page's [oEmbed](https://oembed.com) tag.
- **Confluence:** add an **iframe** or **Embed** macro (depending on your Confluence) and give it the page's link, or the embed address below.
- **Anywhere else:** open **Share**, and under **Embed** copy the code. It looks like this:

```html
<iframe src="{{APP_URL}}/e/<page id>" width="100%" height="600" style="border:0" title="Signups by week" loading="lazy" allowfullscreen></iframe>
```

The page runs in the same sandbox as in the app: its scripts work, but they can't reach the site it is embedded in or your account.

An embed never uses your sign-in, even if you are signed in: the site it sits on shows the same thing to everyone who opens it. So a **Restricted** or **Your organization** page, or a link to a page that doesn't exist, shows the same "Sign in to view this page" card, with a link to open the page in The Artifact. The card never shows the page's title, content or screenshot. If you switch a page from **Anyone with the link** back to **Restricted**, its embeds show the card the next time they load.

Tools that embed by link ask `{{APP_URL}}/api/oembed?url=<page link>` for the embed code. It answers only for pages shared with **Anyone with the link**; for every other page it answers "not found", as if the page didn't exist.

If your server is only reachable on a private network, browsers such as Chrome ask each person before a public site like Notion may show its embeds, or refuse.

A server admin can limit which sites may embed pages with `EMBED_FRAME_ANCESTORS` (see the [configuration reference](/docs/configuration)). The app itself, including `/a/<page id>`, can't be framed by other sites.

## Pages shared with you

The **Shared with you** tab in the gallery lists pages other people shared with your email address, with your role. It shows no [folders](/docs/publishing#folders): those belong to the workspace the page is in, so you don't see how its owner sorts their pages.
