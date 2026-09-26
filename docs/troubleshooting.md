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

Ask the agent to move embedded images and scripts into separate files (see [Publishing](/docs/publishing)), compress them, or load large media from a URL. A page and its files can add up to 10 MB.

## A page's CSS, script or image doesn't load

Files are found by their path relative to the page, exactly as published: `css/site.css` in the HTML needs a file with that path. Paths are case-sensitive, and each version has only the files sent with it. Ask the agent to run `get_artifact` to see which files the current version has.

## Cards show a sketch instead of a screenshot

Screenshots are taken a few seconds after publishing; reload the gallery. On a self-hosted install they need Chromium: the Docker image includes it, and the app log says so when it can't start (usually because the container runs without the seccomp profile from `docker-compose.selfhost.yml`). Pages published before an update get their screenshot the first time the gallery lists them.

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
