# Troubleshooting

## The agent says it needs to authenticate

In Claude Code, run `/mcp`, pick `the-artifact` and choose **Authenticate**. In Codex, run `codex mcp login the-artifact`. If you disconnected the agent in Settings, it has to sign in again.

## "This sign-in link can't be used"

Opening a sign-in link shows a page that asks you to continue as your email address; the link is only used when you press **Continue**, so email security scanners that open links before you do don't use it up. Each link works once, so this message means it was already used (perhaps in another tab or browser, where you are now signed in) or isn't valid. Request a new link from the login page.

## "This sign-in link has expired"

Links work for 15 minutes. Press **Email me a new link** on the same page to get a fresh one sent to the same address.

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

`ALLOWED_EMAIL_DOMAINS` is set and the address isn't in it. Add the domain, or invite the person to an organization or a page first.
