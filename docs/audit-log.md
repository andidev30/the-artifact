# Audit log

The audit log shows what happened in an organization: who signed in, who shared pages or changed who can open them, who joined, left or changed roles, who changed the organization's settings, and who made or revoked access tokens.

**Enterprise feature.** The audit log works on a self-hosted server with an Enterprise license key. An instance admin adds the key under **Server admin**. Without a license, or once a license is past its 14-day grace period, nothing is recorded; events recorded before stay until they reach the end of their retention. The hosted service doesn't have it yet.

## Who can see it

Owners and admins of the organization open it under **Audit log** in the organization's settings. Members don't see it, and to anyone outside the organization it doesn't exist. Without a license that counts, the section isn't shown.

## What is recorded

Every event says when it happened, who did it, what it was about, and the address and browser (user agent) of the request.

| Event | When |
| --- | --- |
| Signed in | A member signs in to the app, with a password, an email link, Google or a passkey, or finishes the second step of two-factor sign-in |
| Sign-in failed | Someone enters a wrong password or a wrong second-factor code for a member's account, or a suspended member tries to sign in |
| Changed who can open a page | General access of an organization page changes (**Restricted**, the organization, or anyone with the link), in the app, through an agent or when publishing a new version |
| Changed a page's link settings | The link of an organization page gets or loses an expiry date or a password, or is reset. The password itself is never recorded |
| Shared a page, changed someone's access, removed someone | People are added to an organization page by email, their role changes, or they are removed |
| Moved a page into the organization, moved a page out of the organization | Someone [moves a page](/docs/sharing#moving-a-page-to-another-workspace) between workspaces. Each organization records its side, with where the page came from or went to, and whether it became **Restricted** |
| Invited someone, revoked an invitation | An owner or admin invites someone or revokes an invitation |
| Joined, changed a role, removed a member, left | Someone accepts an invitation or joins through single sign-on or SCIM, a role changes, an owner or admin removes someone, or someone leaves |
| Suspended, reactivated | Your identity provider deactivates or reactivates a member's account over [SCIM](/docs/scim) |
| Changed settings | The organization's name or its two-factor requirement changes |
| Created an access token, revoked an access token | A member makes an access token for the organization, or someone revokes one |
| Added a webhook, changed a webhook, deleted a webhook | An owner or admin adds, edits, turns on or off, or deletes one of the organization's [webhooks](/docs/webhooks). Only the destination's host is recorded, not its full address |

Sign-ins are recorded in every organization the person belongs to. Failed sign-ins are recorded only when they belong to an account; a wrong email address can't be tied to anyone. Pages in personal workspaces and personal access tokens aren't recorded.

The address is the visitor's. Behind a reverse proxy, set `TRUST_PROXY` so the app reads it from `X-Forwarded-For` (see [Configuration reference](/docs/configuration)); otherwise every event shows the proxy's address.

Recording never holds up the action: the event is written right after it. If writing it fails, the action still happens and the server logs the error.

## Filtering

Narrow the list by **Action**, by **Person** (part of the email address of who did it) and by date with **From** and **To**, then choose **Filter**. Dates are days in your own time zone, and **To** includes the whole day. The list shows the newest events first; **Show more** loads older ones.

## Exporting

**CSV** and **JSON** download every event that matches the current filters, newest first. The CSV has one row per event with these columns:

| Column | What |
| --- | --- |
| `time` | When, in UTC (ISO 8601) |
| `action` | The event, e.g. `sign_in.succeeded`, `page.visibility_changed`, `member.role_changed` |
| `actor_email`, `actor_id` | Who did it |
| `target_type`, `target_id`, `target_label` | What it was about: a page (by its id and title), a member, an invitation, an access token, a webhook or the organization |
| `details` | More about the event as JSON, e.g. `{"from":"private","to":"link"}` or `{"password":"set","reset":true}` |
| `ip`, `user_agent` | Where the request came from |

The JSON export is an array of the same events, each with `id`, `action`, `at`, `actor`, `target`, `details`, `ip` and `userAgent`.

You can also fetch them from `GET {{APP_URL}}/api/organizations/<organization id>/audit-log/export?format=csv` (or `format=json`) with the same filters as query parameters (`action`, `actor`, `from`, `to`), signed in as an owner or admin.

## Retention

Events are kept for 365 days. The server deletes older ones every 6 hours, together with the storage sweep. An operator changes how long with `AUDIT_LOG_RETENTION_DAYS` (see [Configuration reference](/docs/configuration)); export the log first to keep events longer somewhere else. Deleting an organization deletes its audit log.
