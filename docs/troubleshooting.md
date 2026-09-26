# Troubleshooting

## The agent says it needs to authenticate

In Claude Code, run `/mcp`, pick `the-artifact` and choose **Authenticate**. In Codex, run `codex mcp login the-artifact`. If you disconnected the agent in Settings, it has to sign in again.

## "That sign-in link has already been used or is not valid"

Links work once. Some email security scanners open links before you do, which uses them up. Request a new link from the login page.

## I can't open a page someone sent me

You see "This page isn't available" when the page is restricted and your email isn't on it, or when it was deleted. Check that you are signed in with the address it was shared with (the page tells you which one you're using), or ask the owner to share it with you.

## The page looks broken but works as a file

Pages run in a sandbox. Code that reads cookies or `localStorage`, or calls APIs that need the page's own origin, fails there. Keep state in memory, or ask the agent to avoid those APIs.

## "The page is larger than 2 MB"

Ask the agent to compress embedded images, load large assets from a URL, or split the page.

## My agent publishes to the wrong workspace

A connection is tied to the workspace you picked when you allowed it. Disconnect it in **Settings → Connected agents** and connect again, choosing the other workspace.

## Self-hosted: sign-in emails don't arrive

Check the `SMTP_*` settings and the app logs:

```sh
docker compose -f docker-compose.selfhost.yml logs app
```

## Self-hosted: "This server only accepts accounts from invited people"

The sign-up policy doesn't let this address create an account: an admin chose email domains or invited people only under **Admin**, **Sign-up**, or `ALLOWED_EMAIL_DOMAINS` is set and nothing was saved there yet. Add the domain, or invite the person to an organization or a page first.

## Self-hosted: "This account is suspended"

An instance admin suspended the account. An admin can unsuspend it under **Admin**, **People**.

## Self-hosted: nobody is an admin

Add your address to `ADMIN_EMAILS` and restart. See [An existing install without an admin](/docs/self-hosting#an-existing-install-without-an-admin).
