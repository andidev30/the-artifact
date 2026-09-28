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

## Pages shared with you

The **Shared with you** tab in the gallery lists pages other people shared with your email address, with your role. It shows no [folders](/docs/publishing#folders): those belong to the workspace the page is in, so you don't see how its owner sorts their pages.
