# Comments

People leave feedback on a page right next to it, and your agent reads it before it publishes the next version. No more copying feedback from chat into the agent.

## Leaving a comment

Open a page and choose **Comments**. Write in the box at the bottom and choose **Comment** (or press Ctrl+Enter, or Cmd+Enter on a Mac). Each comment shows who wrote it, when, and the version of the page that was current then ("on version 2"), so after a few versions you can still tell what it was about.

Choose **Reply** under a comment to answer it. Threads are one level deep: replies all sit under the comment that started the thread.

Comments are plain text, up to 5,000 characters. Line breaks are kept; nothing else is formatted, and links aren't clickable.

## Pinning a comment to an element

Feedback like "this chart is wrong" is easier to act on when it points at the chart. Under the box for a new comment, choose **Pin to an element**, then click the part of the page the comment is about. Links and buttons on the page don't react while you pick. **Pinned to** shows the element's text; write the comment and choose **Comment**. **Unpin** makes it a comment on the whole page again, and **Cancel** (or Escape) stops picking.

Without a mouse: after **Pin to an element**, focus is on the page. The arrow keys move between its headings, paragraphs, list items, images, tables and other parts (Home and End go to the first and last), a screen reader reads out each one, and Enter chooses. Escape cancels. A comment on the whole page is always the other way to say the same thing.

While the comments are open, each open thread about an element has a numbered pin on the page, at that element, with the same number next to the thread. Choosing a pin goes to its thread, and **Show on page** under a thread scrolls the page to its element. Resolved threads have no pin.

A pinned comment remembers the element's place in the page, its text (up to 200 characters), the version and, for a page with several HTML files, which file. In a later version, the pin finds the element by its place, or by its text if it moved. When neither is there any more, the thread says "The element this comment is about has changed" and quotes the text it had. A thread about an element in another of the page's files says which file.

Only the first comment of a thread is pinned; replies are about what their thread is about. Pinning uses a small helper the viewer adds to the page; on a page whose own scripts stop it, **Pin to an element** doesn't show, and comments on the whole page still work. How the helper is kept apart from the app is in [Security](/docs/security#comments-on-an-element).

## Who can comment

Anyone who is signed in and can open the page can read its comments and write one: the owner, people it is shared with (viewers too), organization members when it is shared with the organization, and anyone signed in who opens a page shared with **Anyone with the link**.

People who open a link-shared page without signing in see the page but not its comments, since comments are often a team's own notes on a page it shows to others. Signing in shows them.

| | Read and write | Edit or delete | Resolve a thread |
| --- | --- | --- | --- |
| The comment's author | Yes | Their own comments | Threads they started |
| Owner, invited editors, organization owners and admins | Yes | Delete any comment on the page | Any thread |
| Invited viewers, organization members, signed-in people with the link | Yes | Their own comments | Threads they started |
| Signed-out visitors | No | – | – |

Deleting the first comment of a thread deletes its replies too. When someone deletes their account, their comments stay, shown as written by a deleted account.

Deleting a page deletes its comments.

## Resolving

When a thread is dealt with, choose **Resolve**. It stays on the page, folded to one line; choose **Show** to read it again, or **Reopen**. A new reply reopens it.

## New comments

Gallery cards show how many comments a page has, and how many are new since you last opened its comments, highlighted. So does the page's **Comments** button. Opening the comments marks them as read, and new ones carry a **New** label until then. Your own comments are never new to you.

## Emails

When the server sends email, the page's owner gets one about each new comment, and the person who started a thread gets one about each reply. Nobody is emailed about their own comments. The email quotes the comment and links straight to the page's comments.

To keep a burst of comments from becoming a burst of emails, each person gets at most one email per page every 15 minutes. Later comments in that time show as new in the app. A self-hosted server can change this with the `comment-email` [rate limit](/docs/configuration#rate-limits).

Without email, nothing is sent; new comments show in the app.

## From your agent

Agents read comments with `list_comments` and answer with `reply_comment`, and can start a thread with `add_comment` and resolve one with `resolve_comment` (see [Publishing](/docs/publishing#list_comments)). For a pinned comment, `list_comments` also gives the element's selector, file, version and text, so the agent knows exactly what to change, and `add_comment` can pin a comment to an element too. They are told to read the open comments before publishing a new version, so you can say "deal with the comments on the launch plan".

A comment from an agent is posted as the person it is connected as, marked with the agent's name, like "via claude-code". It follows that person's access: an agent can comment wherever they can, and resolve what they could resolve in the app.
