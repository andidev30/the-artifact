# Security

## Pages are sandboxed

Pages render in an `<iframe sandbox>` without `allow-same-origin`, so they run with an opaque origin. Their scripts work, but they can't read the app's cookies or storage, call its API with your session, or touch the page around them.

Each version is served as its own document tree, so a page's files resolve by relative paths:

```
/api/artifacts/<id>/v/<version>/            the entry HTML
/api/artifacts/<id>/v/<version>/<path>      its CSS, JS, images, fonts, data
```

- Every response, not just HTML, carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`, so a page, an SVG or an extra HTML file opened on its own is sandboxed too. `X-Content-Type-Options: nosniff` and a fixed content type per extension stop files being read as something else.
- The access rules are the page's: the current version for anyone who can open the page, older versions for its editors only, like the history. A page you can't open answers 404, as if it didn't exist.
- A sandboxed frame has no origin of its own, so browsers don't send your session cookie with the requests it makes for its files. When opening a page needs to know who you are (anything not shared by link, and every older version), the frame's first request, which does carry the cookie, is redirected to `/v/<version>/~<link token>/`, and the page's relative URLs resolve under it. The token is signed by the server, names you, the page and the version, and expires after about 12 hours. Access is checked again on every request, so removing someone from a page locks them out of its files at once. Other pages can't learn a token, so they can't load another page's files with your access.
- **Download** (`/api/artifacts/<id>/download`) serves a version's files as one zip with the same rules, as an attachment that the browser saves rather than opens. The link an agent gets from `download_artifact` carries the same kind of token, for the person the agent is connected as and one version, so it works without a session and is checked again each time it is used.
- Files are sent with `Access-Control-Allow-Origin: *` so the sandboxed page can `fetch()` its own data and load its fonts. Browsers never combine `*` with credentials, so this exposes nothing a signed-out visitor couldn't already open.
- Versions never change, so files are cached privately in your browser for an hour and revalidated by hash.
- **Link keys and passwords.** After a reset, a public link carries a random key (`?k=`), compared in constant time; the page's own address only opens it for people with access of their own. Link passwords are stored as scrypt hashes, like account passwords, and compared in constant time. Passing the key and the password sets an `HttpOnly` cookie that only goes to that page's addresses under `/api/artifacts/<id>` and lasts 12 hours. It holds a signature over the page, its key and its password, so a reset or a new password makes every earlier one useless. The frame's first request carries it and is redirected to `/v/<version>/~<grant>/`, the same signature in the path, like a link token. Wrong passwords are limited per page and per network (see [Rate limits](/docs/configuration#rate-limits)).

## A separate domain for pages

The sandbox is the first line. With `CONTENT_ORIGIN` set (see [A separate domain for pages](/docs/self-hosting#a-separate-domain-for-pages)), page files are served only from that second origin, so a page that got out of its sandbox through a browser bug still wouldn't be on the app's site:

- **The app's cookies never go there.** Every cookie the app sets (the session, pending sign-ins, the link password grant, sign-in flows) is host-only, with no `Domain`, so the browser sends it only to `APP_URL`'s host. With the content origin on another registrable domain, `SameSite` keeps them out of its requests too, and a page there can't set cookies for the app's domain.
- **The content host never reads or sets a cookie.** It gets in only by what the address carries: a link token naming a signed-in viewer, a grant for a link's key and password, or the link's key. The same tokens as above, checked again on every request.
- **It can't act as the app.** It answers only `/api/artifacts/<id>/v/<version>/…`. Sign-in, the API, MCP, OAuth, embeds, link previews and the web app answer 404 there, so a page can't send people to a sign-in form on it, and a request to it can't do anything the app would do.
- **The app's host serves no page content.** A request for a page's files on the app's host is checked with the session, key and grant as before, then redirected to the content origin under a token, or answered 404.
- **Framing.** When `EMBED_FRAME_ANCESTORS` narrows framing, page content lists the app's origin as well, since the app's viewer and embeds frame it from there. Embeds frame the content origin directly, and their `frame-src` names it.

Without `CONTENT_ORIGIN`, pages are served from `APP_URL`, isolated by the sandbox alone.

## Framing and embeds

- **The app can't be framed by other sites.** Every page of the app, `/a/<id>` included, is sent with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so another site can't lay it out under its own buttons (clickjacking). Every response of the app and the API also carries `X-Content-Type-Options: nosniff`, so browsers never read a file as a type other than the one it is sent with.
- **Embeds can.** `/e/<id>` is a small document of its own, without the app: no app scripts, no session, only a sandboxed frame of the page's current version and a link to open it. Its policy is `default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'`, with the content origin added to `frame-src` when there is one. Page content (`/api/artifacts/<id>/v/<version>/`) is framed by the app and by embeds, so the same sites may frame both.
- **Who may embed.** By default any site; `EMBED_FRAME_ANCESTORS` narrows that to a list of origins, sent as `frame-ancestors 'self' <origins>` on embeds and page content (see the [configuration reference](/docs/configuration)). With the default, no `frame-ancestors` is sent at all, since `*` wouldn't match sites that frame embeds from a sandboxed frame of their own.
- **Embeds are never signed in.** Access is checked as a visitor who isn't signed in, ignoring any session cookie, so an embed shows the same thing to everyone. Only pages shared with **Anyone with the link**, with no password and not expired, are embedded. Every other page, and every page that doesn't exist, gets the same "Sign in to view this page" card with no title, content or screenshot, and `GET /api/oembed` answers 404 for them. This also means a site can't use your session to show you a restricted page inside its own frame.

For the strongest isolation on a public install, serve The Artifact on a domain of its own rather than a subdomain of sites that share cookies, and its pages from a [separate domain](#a-separate-domain-for-pages).

## Thumbnails are rendered without network access

Gallery cards show a screenshot of each page, taken on the server in headless Chromium after it is published. Page HTML is untrusted and its scripts run during the render, so:

- **No network of its own.** Every request the page makes is intercepted. The page's own files are answered from memory, never over the API or the network. Everything else is refused, except `GET` requests to a short list of public CDN hosts (jsDelivr, unpkg, cdnjs, esm.sh, Google Fonts and a few more; see `THUMBNAIL_CDN_HOSTS` in the [configuration reference](/docs/configuration)). The server fetches those itself, over HTTPS on port 443, only when every address the host resolves to is public, and connects to the address it checked, so a name can't be pointed at the server's own network in between. Private, loopback, link-local (including the cloud metadata address `169.254.169.254`), shared, multicast and reserved ranges are refused, and so are IPv6 forms that embed an IPv4 address. Redirects go through the same check.
- **A backstop.** Chromium is pointed at a proxy that doesn't exist, localhost included, so traffic that interception might not see (WebSockets, workers) goes nowhere. WebRTC can't send UDP, and DNS prefetching is off.
- **A clean, short-lived browser.** Each render gets a fresh browser context: fixed 1280×720 viewport, no downloads, no service workers, no storage carried over. It has 8 seconds to load and 20 to finish. A page that hangs is abandoned and the browser restarted, without cutting short the other renders still on it.
- **Chromium's own sandbox stays on.** Chromium runs with its sandbox and without the server's environment variables (no database URL or SMTP password). In Docker, the sandbox needs to create namespaces, which Docker's default seccomp profile forbids; `deploy/docker-compose/docker-compose.yml` runs the app with `deploy/seccomp-chromium.json`, which is Docker's default profile plus `clone`, `unshare` and `setns`. Without it, thumbnails are skipped and the log says why.
- **Nothing blocks publishing.** Renders run in the background, two at a time unless `THUMBNAIL_CONCURRENCY` says otherwise. Renders that run at once share one Chromium, but each has its own browser context and its own interception, so one page never sees another's files, storage or requests. If there is no browser, or a render fails, the card keeps its sketch.

When an agent checks a page with [`inspect_artifact`](/docs/publishing#inspect_artifact), the page is opened in the same Chromium under exactly these rules: the same interception, CDN list, proxy, timeouts and fresh context, with no cookies. Only the viewport differs (1280 or 390 pixels wide). The accessibility checker, axe-core, ships with the server and runs in a separate JavaScript world, so the page can neither see nor change it. Inspections run at most `THUMBNAIL_CONCURRENCY` at a time besides thumbnails, are for the page's editors only, and have their own rate limit.

Screenshots are served with the same access rules as the page, from `/api/artifacts/<id>/thumbnails/<version>`. Only pages shared with **Anyone with the link**, with no password and not expired, put their title and screenshot in the link preview tags of `/a/<id>`; every other page gets the same generic tags as a page that doesn't exist (see [Link previews](/docs/sharing#link-previews)).

## Private by default

A page in a personal workspace is restricted until you share it. A page that someone can't open looks the same as one that doesn't exist.

Pages are kept out of search engines. `/robots.txt` asks crawlers to stay away from page links (`/a/`), embeds (`/e/`), page content and the API; a self-hosted install asks them to stay off the whole server, and a separate domain for pages does the same. Chat apps and social sites that unfurl links (Slack, Discord, LinkedIn, X and others) may still read the preview of a page shared with **Anyone with the link**, and only of those.

## Sign-in

- Sign-in links are single-use, expire after 15 minutes and are stored only as a hash.
- Passwords (on servers without email, or once someone sets one) are hashed with scrypt. Wrong ones are [rate limited](/docs/configuration#rate-limits) per address and per network, and so is the current password asked for when changing it. Each attempt is counted before it is checked, so attempts sent at the same time can't get past the limit.
- Sessions are `HttpOnly`, `SameSite=Lax` cookies (`Secure` over HTTPS); the database stores only a hash of the session token.
- **Changes come from the app itself.** Every `POST`, `PUT`, `PATCH` and `DELETE` under `/api` must come from the app's own pages: the browser's `Sec-Fetch-Site` header must say `same-origin`, or, in browsers that don't send it, `Origin` must be `APP_URL`'s origin (a `CONTENT_ORIGIN` or any other host on the same site doesn't count). A request body must be JSON. So another site can't sign you in to an account of its choosing or act with your session, even from a form. Requests with a bearer token (agents, access tokens, SCIM) aren't browser sessions and are exempt, and so is the SAML response an identity provider posts back.
- **After signing in, only this app.** Where to go next (`?next=`, SAML's `RelayState`) must be a path on `APP_URL`. Anything with a backslash or a control character, raw or percent-encoded, or that would resolve to another host, is dropped, and sign-in continues to the gallery.
- Google sign-in uses the authorization code flow with state and PKCE, and only accepts verified Google email addresses.
- [Single sign-on](/docs/sso) (Enterprise) uses OpenID Connect with PKCE, state and nonce, checks the ID token's signature against the provider's keys, and links to an existing account only by an address the provider verified (or one you chose to trust). Client secrets are encrypted at rest. An instance admin can always sign in without it.

## Two-factor sign-in

An account with a passkey or an authenticator app has two-factor sign-in on (how to set it up: [Signing in](/docs/signing-in)). Every first factor ends the same way: a password, an email link (including one an instance admin made), Google and single sign-on each only make a pending sign-in, and the session starts once the second factor checks out.

- **Pending sign-ins** live in their own `HttpOnly`, `SameSite=Lax` cookie, scoped to `/api/auth` and stored as a hash, for at most 10 minutes. It isn't a session: with it you can only finish or abandon the sign-in. It is used up when the session starts, and deleted when the password changes, the account is suspended, or an admin resets its second factor.
- **An email link is one factor.** It proves you can read the mailbox, which is also what an attacker who got into it can do, so it never skips the second factor. The same goes for an admin's sign-in link on a server without email: it sets a new password, and the second factor is still asked for.
- **Wrong codes** (authenticator app and recovery codes) are limited to 10 per account per hour, whichever pending sign-in they come from; a right one clears the count. Each code is counted before it is checked, so codes sent at the same time can't get past the limit. Second-factor steps and passkey sign-ins are also limited per network. See `two-factor` and `two-factor-ip` under [Rate limits](/docs/configuration#rate-limits).
- **Changes need a fresh sign-in.** Adding or removing a passkey or the authenticator app, making new recovery codes, and adding a first password to an account that has none, need a session that signed in within the last hour, through the way the account signs in (an email link, Google, single sign-on or a passkey). Changing an existing password asks for the current one instead. Someone who gets hold of an older session can't give themselves a factor or a password that outlives it, or read new recovery codes. Setting a first password doesn't make the session any fresher than it was.

### Passkeys

Passkeys are WebAuthn credentials, checked with [SimpleWebAuthn](https://simplewebauthn.dev). The relying party is the install's own address: the RP ID is the host name of `APP_URL` and every response must come from its origin, so a passkey made for one install never works on another or on a look-alike domain. Changing the host name in `APP_URL` makes existing passkeys unusable; people sign in another way and add new ones.

- The server keeps only the public key, the credential id, the signature counter and whether the passkey is synced. No attestation is asked for, so any authenticator works.
- Every challenge is random, works once and for 5 minutes, and is bound to what it was made for (adding a passkey, signing in, or one person's second step). It is deleted as it is checked, so a response can't be replayed. A counter that goes backwards is refused.
- **Signing in with a passkey alone counts as both factors**, so it requires user verification: the authenticator must check a fingerprint, face or PIN, not just a touch. Passkeys the authenticator keeps as discoverable (most do) sign in without an email address being typed.
- As a second factor after a password, email link or Google, a touch is enough, and only the account's own passkeys are accepted.

### Authenticator apps

- Codes follow RFC 6238 with the settings every app supports: HMAC-SHA1, 6 digits, 30-second steps. A code is accepted for the step before and after the current one as well, for clocks that are a little off.
- A code is accepted once. The server records the last step it accepted in the same statement that checks it, so a code, or any older one, can't be used again, even by two requests at the same moment.
- The secret is 20 random bytes, encrypted at rest with AES-256-GCM under a key the server makes for itself on first use and keeps in the `server_secrets` table. A copy of the other tables, or a query log, doesn't reveal it; a full database backup holds both, so protect backups like the database itself.
- It counts only once a first code from the app is confirmed.

### Recovery codes

Ten single-use codes, each 10 characters from an alphabet without look-alike characters (about 49 bits). They are shown once, when the first factor is added or when new ones are made, and stored only as SHA-256 hashes. Using one deletes it. Making new ones deletes the old ones; so does removing the last passkey and the authenticator app.

### Losing every factor

There is no self-service way around the second factor: that would be the way in for an attacker too. An instance admin can **Reset two-factor sign-in** for someone else under **Server admin**, **People**. It deletes their passkeys, authenticator app, recovery codes and pending sign-ins, signs them out everywhere, and writes a warning to the log with both account ids. Admins can't do it for themselves (they use their own settings, or another admin). With a shell on the server, `reset-two-factor.js` does the same for any account, so the only admin isn't locked out for good (see [An existing install without an admin](/docs/self-hosting#an-existing-install-without-an-admin)). Organization owners and admins can't reset anyone's second factor.

### Organizations that require it

Owners and admins can turn on **Require two-factor sign-in** once they have a second factor themselves. Members without one are sent to set it up when they sign in, and until they do, they are treated as outside the organization everywhere:

- In the web app, its gallery, folders and settings answer that it requires two-factor sign-in, and they can't connect an agent to it or make access tokens for it. They can still leave it.
- Agents already connected to the organization and access tokens already made for it are refused, including refreshing an agent's token. They aren't deleted: they work again once the person adds a second factor.
- Agents and access tokens for their personal workspace or another organization can't open or change the organization's pages, and neither can links to page content made for them before (the sandboxed frame's link and an agent's download link), which are checked again on every use.
- Its pages open only if they are shared with them directly or by link.

## Sessions

- A session lasts 30 days and is extended while it is used. **Account settings**, **Sessions** lists yours with the browser and system (from the `User-Agent` at sign-in; no IP addresses or locations are kept) and when each one signed in and was last active, which is updated at most every 5 minutes.
- **Sign out** ends one session and **Sign out other devices** ends every other one, at once. The list names sessions by a value derived from the stored hash, never the hash or the token.
- Changing your password ends every other session, and so does a password set with an admin's link. Suspension and an admin's two-factor reset end all of them.

## Agent access

- Agents connect with OAuth 2.1: dynamic client registration, authorization code with PKCE (S256), and your explicit approval on a consent screen.
- Redirects are limited to HTTPS, loopback addresses and app schemes.
- Access tokens last an hour; refresh tokens rotate on every use. A used refresh token is kept until it would have expired: if it is presented again, someone else has a copy, so every token of that connection is revoked and the agent has to connect again (OAuth 2.1 refresh token reuse detection). All tokens are stored as hashes.
- An agent acts for one person in one workspace, and only with that person's permissions. Disconnect it in **Account settings** to revoke it immediately.
- Every request checks the agent's token against the database: it is refused for a suspended account, and for an organization the person is no longer in or that requires a second factor they haven't set up. Membership is also checked when an approval is exchanged for tokens and when a token is refreshed, and leaving or being removed from an organization deletes the agent's tokens and pending approvals for it.

## Access tokens

- [Access tokens](/docs/connect-your-agent#publishing-from-ci) for CI are made in **Account settings** by someone signed in to the app, never by another token. Making them is [rate limited](/docs/configuration#rate-limits) per account.
- A token is `art_` followed by 32 random bytes in base64url, so secret scanners can recognize one that leaks. It is shown once; the server stores only its SHA-256 hash.
- It acts for one person in one workspace with that person's permissions, on `/mcp` and `POST /api/publish` only. The app's cookie-authenticated routes ignore it.
- Every request checks the token against the database, with nothing cached: a revoked or expired token is refused on its next request. So is a token for an organization its owner is no longer in or that requires a second factor its owner hasn't set up, or of a suspended account. Leaving an organization, being removed from it, and suspension also delete the tokens they affect.
- Owners and admins of an organization can list and revoke every member's tokens for it. The list shows names and dates, never the token.

## Instance admins

- On a self-hosted install the first account becomes the instance admin; more can be added from the admin area, or from the server with the make-admin script. See [The instance admin](/docs/self-hosting#the-instance-admin).
- Admins manage accounts and organizations. They can't read private pages through the admin area: it shows counts, not page content.
- Suspending someone deletes their sessions, agent tokens and access tokens at once, and refuses their sign-in links, Google sign-in, passkeys and MCP calls until they are unsuspended. Links to page content made for them (the sandboxed frame's link and an agent's download link) are signed rather than stored, so they are checked against suspension each time they are used and stop working at once too.
- Resetting someone's two-factor sign-in is logged; see [Losing every factor](#losing-every-factor).
- The last admin can't be removed, suspended or deleted, so an install always keeps a way in.

## Page views

Opening a page is counted, and for pages shared with specific people or an organization, the server records who opened it and when. That record is deleted after 90 days, and only people who can edit the page see it. Visits through a link shared with **Anyone with the link** are counted without recording who made them or their address. See [Who opened a page](/docs/sharing#who-opened-a-page).

## Self-hosted data

Everything lives in your own Postgres database and object storage: accounts and version history in Postgres, page HTML, files and thumbnails in the bucket. Nothing is sent to us, and the app's own fonts and scripts are served by your server rather than a CDN. The bucket should stay private; pages are only ever served through the app, which checks access and adds the sandbox headers. While rendering thumbnails, the server may fetch scripts and fonts that pages load from the public CDNs listed above; set `THUMBNAIL_CDN_HOSTS=none` to turn that off.
