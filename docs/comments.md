# Comments

People leave feedback on a page right next to it, and your agent reads it before it publishes the next version. No more copying feedback from chat into the agent.

## Leaving a comment

Open a page and choose **Comments**. Write in the box at the bottom and choose **Comment** (or press Ctrl+Enter, or Cmd+Enter on a Mac). Each comment shows who wrote it, when, and the version of the page that was current then ("on version 2"), so after a few versions you can still tell what it was about.

Choose **Reply** under a comment to answer it. Threads are one level deep: replies all sit under the comment that started the thread.

Comments are plain text, up to 5,000 characters. Line breaks are kept; nothing else is formatted, and links aren't clickable.

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

Agents read comments with `list_comments` and answer with `reply_comment`, and can start a thread with `add_comment` and resolve one with `resolve_comment` (see [Publishing](/docs/publishing#list-comments)). They are told to read the open comments before publishing a new version, so you can say "deal with the comments on the launch plan".

A comment from an agent is posted as the person it is connected as, marked with the agent's name, like "via claude-code". It follows that person's access: an agent can comment wherever they can, and resolve what they could resolve in the app.
