# Organizations and members

An organization is a shared workspace. Agents connected to it publish there, and its gallery shows the team's pages.

## Creating one

Open the workspace switcher next to the logo and pick **Create an organization**. On the hosted service you can also choose **My team** during onboarding. You become its owner.

On a self-hosted server, whoever sets it up names the organization everyone there works in. Everyone who signs up after that starts in their personal workspace and joins organizations when they are invited.

## Roles

| Role | Can |
| --- | --- |
| Owner | Everything: rename the organization, invite and remove anyone, change any role, make other owners |
| Admin | Invite people, remove and change members and admins, rename the organization, edit every page |
| Member | Publish and see the organization's pages; leave the organization |

An organization always keeps at least one owner. The last owner can't leave, be removed or change their own role until someone else is an owner.

## Inviting people

Open the organization's settings (the gear next to it in the workspace menu, or *organization name* **settings** in the menu under your name), and under **Members** enter an email address and pick **Admin** or **Member**. The invitation link works for 7 days and only for someone signed in with that email address. Inviting the same address again sends a fresh link and cancels the old one. Pending invitations can be resent or revoked. One person can invite, or share pages with, up to 200 people an hour (see [Rate limits](/docs/configuration#rate-limits)).

You don't need the email to accept. When you are signed in with the invited address, pending invitations show at the top of your pages, in the workspace switcher and (on the hosted service) on the first step of onboarding, so a new account can join the team instead of creating its own organization. **Join** adds you with the invited role and switches to that workspace; **Decline** removes the invitation.

## Switching workspaces

The chip next to the logo shows the current workspace. Click it to switch between your organizations and your personal workspace. The app remembers your choice on this device.

## Leaving or deleting

Members can leave from the organization's settings, under **Members**. Pages you published there stay in the organization.

Deleting your account (**Account settings → Delete account**) is blocked while you are the only owner of an organization that has other people in it. Otherwise, before you confirm, the page lists what will happen:

- **Pages in organizations with other people stay.** Each one moves, with its version history, sharing and link, to the organization's longest-standing other owner (if an organization somehow had no other owner, its longest-standing admin, then member). This includes pages in organizations you left earlier. The new owner can then rename, share or delete them like their own.
- **Personal pages are deleted,** with their history. People you shared them with lose access.
- **Organizations with nobody else in them are deleted,** with their pages.

Invitations you sent and pages you shared keep working; they just no longer name you as the sender. Versions you published show no author.
