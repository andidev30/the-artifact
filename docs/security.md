# Security

## Pages are sandboxed

Pages render in an `<iframe sandbox>` without `allow-same-origin`, so they run with an opaque origin. Their scripts work, but they can't read the app's cookies or storage, call its API with your session, or touch the page around them. Page content served directly (for thumbnails) carries a `Content-Security-Policy: sandbox` header for the same effect.

For the strongest isolation on a public install, serve The Artifact on a domain of its own rather than a subdomain of sites that share cookies.

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

## Self-hosted data

Everything, including page HTML and version history, lives in your Postgres database. Nothing is sent to us.
