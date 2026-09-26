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
- Files are sent with `Access-Control-Allow-Origin: *` so the sandboxed page can `fetch()` its own data and load its fonts. Browsers never combine `*` with credentials, so this exposes nothing a signed-out visitor couldn't already open.
- Versions never change, so files are cached privately in your browser for an hour and revalidated by hash.

For the strongest isolation on a public install, serve The Artifact on a domain of its own rather than a subdomain of sites that share cookies.

## Thumbnails are rendered without network access

Gallery cards show a screenshot of each page, taken on the server in headless Chromium after it is published. Page HTML is untrusted and its scripts run during the render, so:

- **No network of its own.** Every request the page makes is intercepted. The page's own files are answered from memory, never over the API or the network. Everything else is refused, except `GET` requests to a short list of public CDN hosts (jsDelivr, unpkg, cdnjs, esm.sh, Google Fonts and a few more; see `THUMBNAIL_CDN_HOSTS` in the [configuration reference](/docs/configuration)). The server fetches those itself, over HTTPS on port 443, only when every address the host resolves to is public, and connects to the address it checked, so a name can't be pointed at the server's own network in between. Private, loopback, link-local (including the cloud metadata address `169.254.169.254`), shared, multicast and reserved ranges are refused, and so are IPv6 forms that embed an IPv4 address. Redirects go through the same check.
- **A backstop.** Chromium is pointed at a proxy that doesn't exist, localhost included, so traffic that interception might not see (WebSockets, workers) goes nowhere. WebRTC can't send UDP, and DNS prefetching is off.
- **A clean, short-lived browser.** Each render gets a fresh browser context: fixed 1280×720 viewport, no downloads, no service workers, no storage carried over. It has 8 seconds to load and 20 to finish. A page that hangs is abandoned and the browser restarted.
- **Chromium's own sandbox stays on.** Chromium runs with its sandbox and without the server's environment variables (no database URL or SMTP password). In Docker, the sandbox needs to create namespaces, which Docker's default seccomp profile forbids; `docker-compose.selfhost.yml` runs the app with `docker/seccomp-chromium.json`, which is Docker's default profile plus `clone`, `unshare` and `setns`. Without it, thumbnails are skipped and the log says why. `CHROME_NO_SANDBOX=true` renders without Chromium's sandbox; only use it when the container is isolated some other way.
- **Nothing blocks publishing.** Renders run one at a time in the background. If there is no browser, or a render fails, the card keeps its sketch.

Screenshots are served with the same access rules as the page, from `/api/artifacts/<id>/thumbnails/<version>`.

## Private by default

A page in a personal workspace is restricted until you share it. A page that someone can't open looks the same as one that doesn't exist.

## Sign-in

- Sign-in links are single-use, expire after 15 minutes and are stored only as a hash.
- Sessions are `HttpOnly`, `SameSite=Lax` cookies (`Secure` over HTTPS); the database stores only a hash of the session token.
- Google sign-in uses the authorization code flow with state and PKCE, and only accepts verified Google email addresses.

## Agent access

- Agents connect with OAuth 2.1: dynamic client registration, authorization code with PKCE (S256), and your explicit approval on a consent screen.
- Redirects are limited to HTTPS, loopback addresses and app schemes.
- Access tokens last an hour; refresh tokens rotate on every use. All tokens are stored as hashes.
- An agent acts for one person in one workspace, and only with that person's permissions. Disconnect it in **Settings** to revoke it immediately.

## Instance admins

- On a self-hosted install the first account becomes the instance admin; more can be added from the admin area or with `ADMIN_EMAILS`. See [The instance admin](/docs/self-hosting#the-instance-admin).
- Admins manage accounts and organizations. They can't read private pages through the admin area: it shows counts, not page content.
- Suspending someone deletes their sessions and agent tokens at once, and refuses their sign-in links, Google sign-in and MCP calls until they are unsuspended.
- The last admin can't be removed, suspended or deleted, so an install always keeps a way in.

## Self-hosted data

Everything, including page HTML, files, thumbnails and version history, lives in your Postgres database. Nothing is sent to us. While rendering thumbnails, the server may fetch scripts and fonts that pages load from the public CDNs listed above; set `THUMBNAIL_CDN_HOSTS=none` to turn that off.
