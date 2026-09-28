# Organizations and members

An organization is a shared workspace. Agents connected to it publish there, and its gallery shows the team's pages.

## Creating one

Open the workspace switcher next to the logo and pick **Create an organization**. You become its owner.

On the hosted service, new organizations are coming soon: they open together with the Organization plan and its billing. Until then everyone starts in a personal workspace, and the workspace switcher says so instead of offering **Create an organization**. Organizations that already exist keep working as before, and you can still join one when you are invited.

On a self-hosted server, whoever sets it up names the organization everyone there works in. Everyone who signs up after that starts in their personal workspace and joins organizations when they are invited.

## Roles

| Role | Can |
| --- | --- |
| Owner | Everything: rename the organization, invite and remove anyone, change any role, make other owners, [require two-factor sign-in](#requiring-two-factor-sign-in), set [version retention](#version-retention) |
| Admin | Invite people, remove and change members and admins, rename the organization, require two-factor sign-in, edit every page, see and revoke every member's [access tokens](#access-tokens) for it, set version retention |
| Member | Publish and see the organization's pages; create, rename and delete its [folders](/docs/publishing#folders); leave the organization |

An organization always keeps at least one owner. The last owner can't leave, be removed or change their own role until someone else is an owner.

## Inviting people

Open the organization's settings (the gear next to it in the workspace menu, or *organization name* **settings** in the menu under your name), and under **Members** enter an email address and pick **Admin** or **Member**. The invitation link works for 7 days and only for someone signed in with that email address. Inviting the same address again sends a fresh link and cancels the old one. Pending invitations can be resent or revoked. One person can invite, or share pages with, up to 200 people an hour (see [Rate limits](/docs/configuration#rate-limits)).

You don't need the email to accept. When you are signed in with the invited address, pending invitations show at the top of your pages, in the workspace switcher and (on the hosted service) on the first step of onboarding, so a new account can join the team instead of starting on its own. **Join** adds you with the invited role and switches to that workspace; **Decline** removes the invitation. On a server without email, an account someone created on their own with a password doesn't see them: it joins with the invitation link (see [Running without email](/docs/self-hosting#running-without-email)).

## Switching workspaces

The chip next to the logo shows the current workspace. Click it to switch between your organizations and your personal workspace. The app remembers your choice on this device.

## Moving pages between workspaces

Pages can move between your personal workspace and an organization, or from one organization to another, with **Move to workspace** in their **…** menu, and be copied with **Duplicate**. Moving keeps the page's link, owner, the people it is shared with, its link settings, comments and views; it leaves its folder, and a page open to **Your organization** becomes **Restricted** when it moves to a personal workspace. Moving takes edit access to the page and membership in both workspaces; only the owner moves a page into or out of their personal workspace. Once a page arrives, the organization's rules apply to it: two-factor sign-in, version retention and its audit log. See [Duplicating and moving pages](/docs/sharing#duplicating-a-page).

On the hosted service, new organizations are not available yet, but you can move and duplicate pages into the organizations you already belong to.

## Access tokens

Members make [access tokens](/docs/connect-your-agent#publishing-from-ci) in **Account settings** to publish to the organization from CI. Owners and admins see every member's tokens for the organization under **Access tokens** in its settings: the name, who made it, when it was last used and when it expires, never the token itself. **Revoke** stops a token at once, whoever made it, so a token that leaks doesn't have to wait for its owner.

## Webhooks

Owners and admins can add [webhooks](/docs/webhooks) under **Webhooks** in the organization's settings, so a Slack or Discord channel, or your own server, hears when a page in the organization is published, commented on or opened. Members don't see them.

## Requiring two-factor sign-in

Owners and admins can check **Require two-factor sign-in** under **General** in the organization's settings. You need a passkey or an authenticator app on your own account first (see [Signing in](/docs/signing-in)), so turning it on can't lock you out. **Members** shows who has two-factor sign-in (**2FA on**) and who doesn't yet (**No 2FA**).

Members without it are sent to **Sign-in security** the next time they sign in. Until they add a passkey or an authenticator app, they can't open the organization's gallery, folders or settings in the app, see its pages (except ones shared with them directly or by link), connect a new agent to it or make access tokens for it. The notice on their pages says so. They can still leave the organization.

Agents they already connected to the organization and access tokens they already made for it stop working too, and their other agents can't reach its pages. So before you turn it on, check under **Members** that people whose CI publishes to the organization have **2FA on**. Nothing is deleted: their agents and tokens work again as soon as they add a second factor, and turning the requirement off lets everyone back in at once.

Only an instance admin can reset someone's second factor if they lose it; owners and admins of an organization can't.

## Version retention

On a self-hosted server with an Enterprise license, owners and admins can choose under **Version history** in the organization's settings how long older versions of its pages are kept. See [Version retention](/docs/retention).

## Exporting the organization

Owners can download everything in the organization, its pages with their versions, sharing and comments, and its members and settings, as one zip under **Export data** in the organization's settings. See [Exporting your data](/docs/exporting-your-data).

## Audit log

On a self-hosted server with an Enterprise license, owners and admins see who signed in, shared pages, changed members or settings, and made or revoked access tokens under **Audit log** in the organization's settings. See [Audit log](/docs/audit-log).

## Leaving or deleting

Members can leave from the organization's settings, under **Members**. Pages you published there stay in the organization. Agents you connected to it and access tokens you made for it stop working at once.

Deleting your account (**Account settings → Delete account**) is blocked while you are the only owner of an organization that has other people in it. Otherwise, before you confirm, the page lists what will happen:

- **Pages in organizations with other people stay.** Each one moves, with its version history, sharing and link, to the organization's longest-standing other owner (if an organization somehow had no other owner, its longest-standing admin, then member). This includes pages in organizations you left earlier. The new owner can then rename, share or delete them like their own.
- **Personal pages are deleted,** with their history. People you shared them with lose access.
- **Organizations with nobody else in them are deleted,** with their pages.

Invitations you sent and pages you shared keep working; they just no longer name you as the sender. Versions you published show no author.
