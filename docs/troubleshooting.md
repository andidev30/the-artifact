# Troubleshooting

## The agent says it needs to authenticate

In Claude Code, run `/mcp`, pick `the-artifact` and choose **Authenticate**. In Codex, run `codex mcp login the-artifact`. If you disconnected the agent in Account settings, it has to sign in again.

## "This sign-in link can't be used"

Opening a sign-in link shows a page that asks you to continue as your email address; the link is only used when you press **Continue**, so email security scanners that open links before you do don't use it up. Each link works once, so this message means it was already used (perhaps in another tab or browser, where you are now signed in) or isn't valid. Request a new link from the login page.

## "This sign-in link has expired"

Links work for 15 minutes. Press **Email me a new link** on the same page to get a fresh one sent to the same address.

## "Too many …, try again in …"

The server limits how often one address, account or network can ask for sign-in links, try passwords, invite people or use agent tools (see [Rate limits](/docs/configuration#rate-limits)). The limit ends on its own after the time the message gives. On a self-hosted server, if everyone behind the same office network or reverse proxy hits it together, the admin can set `TRUST_PROXY` or raise the limit with `RATE_LIMITS`.

## I lost my phone or my passkey

On **Confirm it’s you**, choose **Use a recovery code** and enter one of the codes you saved when you set up two-factor sign-in. Once you are in, remove the lost passkey or set up the authenticator app again under **Account settings**, **Sign-in security**, and make new recovery codes. Without a recovery code, ask an admin of this server to reset your two-factor sign-in; see [If you lose your second factor](/docs/signing-in#if-you-lose-your-second-factor).

## "That code is wrong or was already used"

Each code from an authenticator app works once. Wait for the app to show the next one. If new codes keep failing, the phone's clock is probably off by more than 30 seconds: set its time to update automatically.

## "… requires two-factor sign-in"

The organization's owners require a passkey or an authenticator app. Add one under **Account settings**, **Sign-in security**, and the organization opens again at once. See [Organizations that require it](/docs/signing-in#organizations-that-require-it).

## "Sign in again to change how you sign in"

Adding or removing passkeys and the authenticator app, and making new recovery codes, need a sign-in from the last hour. Choose **Sign in again**, sign in, and you return to **Sign-in security**.

## "Your personal workspace has … pages" or "… past … of storage"

The workspace is full. Delete pages you no longer need in the gallery, or ask the agent to publish a new version of a page you have. See [Limits](/docs/publishing#limits).

## I can't open a page someone sent me

You see "This page isn't available" when the page is restricted and your email isn't on it, or when it was deleted. Check that you are signed in with the address it was shared with (the page tells you which one you're using), or ask the owner to share it with you.

## The page looks broken but works as a file

Pages run in a sandbox. Code that reads cookies or `localStorage`, or calls APIs that need the page's own origin, fails there. Keep state in memory, or ask the agent to avoid those APIs.

## "The page is larger than 2 MB"

Ask the agent to move embedded images and scripts into separate files (see [Publishing](/docs/publishing)), compress them, or load large media from a URL. A page and its files can add up to 10 MB.

## A page's CSS, script or image doesn't load

Files are found by their path relative to the page, exactly as published: `css/site.css` in the HTML needs a file with that path. Paths are case-sensitive, and each version has only the files sent with it. Ask the agent to run `get_artifact` to see which files the current version has.

## Cards show a sketch instead of a screenshot

Screenshots are taken a few seconds after publishing; reload the gallery. On a self-hosted install they need Chromium: the Docker image includes it, and the app log says so when it can't start (usually because the container runs without the seccomp profile from `deploy/docker-compose/docker-compose.yml`). Pages published before an update get their screenshot the first time the gallery lists them.

## My agent publishes to the wrong workspace

A connection is tied to the workspace you picked when you allowed it. Disconnect it in **Account settings → Connected agents** and connect again, choosing the other workspace.

## Self-hosted: sign-in emails don't arrive

With `SMTP_HOST` empty nothing is emailed by design; see [Running without email](/docs/self-hosting#running-without-email). Otherwise check the `SMTP_*` settings and the app logs:

```sh
docker compose logs app
```

## Kubernetes: the app pod doesn't start

If `kubectl -n the-artifact describe pod` says the seccomp profile couldn't be loaded, the node running the pod lacks `/var/lib/kubelet/seccomp/profiles/the-artifact-chromium.json`. Copy it there, or run without thumbnails. See [The seccomp profile](/docs/kubernetes#3-the-seccomp-profile).

If the pod waits in `Init`, the app can't reach the database or object storage yet: `kubectl -n the-artifact logs deploy/the-artifact -c wait-for-services` says which address it is waiting for.

## Self-hosted: "This server only accepts accounts from invited people"

The sign-up policy doesn't let this address create an account: an admin chose email domains or invited people only under **Server admin**, **Sign-up**. Add the domain, or invite the person to an organization or a page first. On a server without email, an admin can also make them a sign-up link under **People**.

## Self-hosted: "This account is suspended"

An instance admin suspended the account. An admin can unsuspend it under **Server admin**, **People**.

## Self-hosted: nobody is an admin

Run the make-admin script on the server. See [An existing install without an admin](/docs/self-hosting#an-existing-install-without-an-admin).

## Self-hosted: I forgot my password

Ask an instance admin for a **Password reset link** (under **Server admin**, **People**). If you are the only admin, run the make-admin script with your address; on a server without email it prints a reset link.
