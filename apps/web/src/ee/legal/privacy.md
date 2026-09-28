# Privacy Policy

Last updated: 29 September 2026

This policy explains what personal data The Artifact's hosted service at {{APP_URL}} (the "service") collects, why, who else handles it, how long we keep it, and what you can ask of us.

## Who we are

The service is run by an individual, not a company, based in Tebet, Jakarta Selatan, DKI Jakarta, Indonesia. For your account data, that person is the data controller (pengendali data pribadi). In this policy, "we" and "us" mean that person.

Contact for privacy questions and data requests: [andidev30.personal@gmail.com](mailto:andidev30.personal@gmail.com).

We follow Indonesia's Personal Data Protection Law, UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP).

## What this policy covers

- It covers the hosted service and its website.
- It doesn't cover self-hosted installs of The Artifact. Whoever runs such an install is responsible for the data in it, and it sends nothing to us.
- It doesn't cover what people put inside their pages. For personal data inside pages that an organization publishes, we act for that organization as its processor, under our [Data Processing Addendum](/legal/dpa).

## What we collect and why

### Your account

- Your email address, and the name you give.
- If you sign in with Google: your Google account id, and the link to your Google profile picture.
- If you set a password: a scrypt hash of it, never the password itself.
- When the account was created, and when you last used it (updated at most every few minutes).

We use this to create your account, sign you in, show your name to people you work with, and send you the emails the service needs.

### Sign-in security

- Passkeys: the public key, the credential id, the name you give the passkey, and when it was last used. Your device keeps the private key; we never see it.
- Authenticator app: the shared secret, stored encrypted.
- Recovery codes: stored as hashes.
- Sign-in links: your email and a hash of the link. A link expires after 15 minutes and works once.

### Sessions

When you sign in, we store a hash of your session token, your browser's user agent (so you can recognize your sessions in settings), when the session started, and when it was last active. A session lasts 30 days and is renewed while you use it. We don't store your IP address with your session.

### Organizations, invitations and sharing

- An organization's name and address, its members and their roles.
- Invitations: the invited email address, the role, who sent it, and a hash of the link. An invitation expires after 7 days.
- Pages shared with people by email: their email address and their role on the page.

We send invitation and share emails to those addresses. People you invite or share with see your name or email as the sender.

### Agents and access tokens

- When an agent connects, it registers itself with a name and the addresses it returns to after sign-in. We store hashes of the tokens it gets, and when they were last used. Access expires after 1 hour and is renewed; a connection that isn't used for 60 days ends.
- Access tokens you create for scripts and CI: the name you give it, a hash of the token, when it expires, and when it was last used.

### Pages

- The HTML and files of every version, the title, which agent or tool published it, who published each version, when, the folder, and the sharing settings.
- On the free Personal plan, versions older than 7 days are removed every day. A page's current version is kept.

We store pages to serve them to the people you choose. We don't read them as part of normal operation (see the [Terms](/legal/terms#your-pages)).

### Screenshots

When screenshots are on, the service opens each new version in a headless browser on our own servers and saves a small picture of it for your gallery. The browser has no network of its own. It may fetch public files the page uses from a short list of public CDNs, and nothing else. No page content goes to a third party for this.

For pages shared by link, the title and screenshot are shown as a link preview when someone pastes the link into a chat app.

### Comments

The text of each comment, who wrote it, which agent posted it if any, when it was written, edited or resolved, and when you last read the comments on a page. We email a page's owner about new comments, and the author of a thread about replies, with the comment's text and the page's title.

### Who opened a page

For each version of a page, we count how many times it was opened. When someone opens a page as themselves, for example an organization page or a page shared with them by email, we can record who opened it and when, and show it to the page's editors. We keep these records for 90 days. Visits through a shared link are only counted: we don't record who the visitor is.

### Webhooks

An organization's owners and admins, and anyone for their personal workspace, can add webhooks: addresses the service tells when a page is published, commented on or opened. We store each webhook's address, the events chosen and a signing secret, and a log of what was sent for 14 days. Each message holds the workspace's name, the page's title and address, the version, the name of the person who acted, and for comments the first 200 characters. It never holds email addresses or page content. The destination, such as Slack, Discord or your own server, receives what the workspace admin configured, and its own terms apply there; it isn't one of our sub-processors.

### Product events

To see where people get stuck, we record a few steps in our own database, the first time your account reaches each one: when the account is created (and whether with an email link, a password or Google), when you finish the first setup screen, when an agent or access token first connects, when you first publish a page, and when you first share a page (by link, with your organization, or with a person). Each event holds your account id, the step, that one detail, and when it happened. It never holds page content, page titles, email addresses or IP addresses. We also count how many pages are published each day, without saying by whom.

We don't send these events to any third-party analytics service, and they use no cookies. We keep them for 13 months. They are deleted when you delete your account.

### Data exports

When you ask for an export of your data in **Account settings**, or an owner asks for one of an organization, we build a zip file of it in our file storage and record who asked for it, when, whether it holds every version, and how far the build got. When it is ready we email you a link to settings, where you download it. The zip is kept for 24 hours after it is ready and only the person who asked for it can download it, signed in. See [Exporting your data](/docs/exporting-your-data) for what is in it.

### Contact sales

If you use the contact sales form, we receive your name, work email, company, team size and message by email. We use it only to reply to you. We don't store it in the service's database. We keep the email as long as we need it to talk with you, and delete it when you ask.

### Website analytics

On the website and in the app, we use Vercel Web Analytics and Vercel Speed Insights. They record the address of the screen you open, the page you came from, your browser, operating system, device type and country, and how fast the screen loaded. Before an address leaves your browser, we remove everything after a "?" or "#", invitation tokens and page links, so sign-in links and private links never reach Vercel. The analytics are not loaded on self-hosted installs. They use no cookies. Vercel tells visitors apart with a hash of the request that changes every day, so they can't follow you over time or across sites. We use this to see which parts of the site are used and to find slow screens.

### Rate limits

To stop abuse, we count requests for some actions, such as sign-in attempts, per email address, per account or per IP address. We store only a SHA-256 hash of the email, account id or address, with a counter. Counters are deleted after their time window ends, within about a day.

### Logs and metrics

Our servers write a log line for each request: the time, a request id, the method, the route pattern (not the full address), the status and how long it took. Some security events, such as adding a passkey, log your account id. If an email can't be sent, the log can include the recipients' addresses. Our logs don't include IP addresses or page content. Vercel, our host, also keeps its own short-lived logs of requests, which can include IP addresses.

We also keep counts and timings for monitoring (for example, how many requests each route answered). They hold no personal data.

## Why we are allowed to use it

Under UU PDP, we rely on:

- **Performing our agreement with you:** your account, sign-in, sessions, organizations, pages, sharing, comments and the emails that go with them.
- **Legitimate interests:** keeping the service secure and working (rate limits, logs, monitoring, sign-in security), and improving it (website analytics, product events), in ways you would reasonably expect.
- **Consent:** when you choose to sign in with Google, or send us the contact sales form.
- **Legal obligations:** when the law requires us to keep or disclose data.

## Who else sees your data

- **The people you choose.** People you share pages with, and members of your organizations, see your name or email next to what you publish, share and comment. Organization owners and admins can see members' email addresses and manage their pages.
- **Webhook destinations** that an organization's owners and admins, or you for your personal workspace, choose. They receive what is described under [Webhooks](#webhooks).
- **Service providers** that host and run the service for us. They are listed on the [Sub-processors](/legal/subprocessors) page, with what they do and where.
- **Google,** only if you choose to sign in with Google. Google's own privacy policy applies to that.
- **Authorities,** when the law requires it. We only disclose what is required.

We don't sell personal data, and we don't use it for advertising.

## Where your data is

Our servers run in Tokyo, Japan, on Vercel. The database and file storage are run by Supabase, and emails are sent through Brevo in France. Vercel and Supabase are based in the United States and may process data there or in other countries. This means your data leaves Indonesia. We choose providers that protect personal data at least as well as UU PDP requires, under their data processing terms.

## Cookies and browser storage

We use only the cookies the service needs to work:

| Cookie | What it's for | How long |
| --- | --- | --- |
| `session` | Keeps you signed in | 30 days, renewed while you use it |
| `sign_in_pending` | Holds your place between the first step of signing in and your second factor | 10 minutes |
| `google_state`, `google_verifier`, `google_plan`, `google_next` | Protect a Google sign-in and bring you back to the right place | 10 minutes, only during a Google sign-in |

The app also keeps the workspace you last chose in your browser's local storage, so it opens there next time. That never leaves your browser.

We use no advertising cookies and no tracking cookies. Website analytics use no cookies.

## How long we keep data

- Account data: until you delete your account.
- Pages, versions, comments and organizations: until they are deleted. On the free Personal plan, older versions go after 7 days.
- Sessions, sign-in links, invitations and tokens: they stop working when they expire, and are deleted when they are used, when you sign out or end them, or with your account.
- Records of who opened a page: 90 days.
- Webhook delivery logs: 14 days.
- Product events: 13 months, or until you delete your account.
- Rate limit counters: about a day after their window ends.
- Data exports: the zip can be downloaded for 24 hours, and the daily cleanup deletes it after that. The record that you asked for one goes with it; one that failed goes after a day.
- Vercel's request logs and website analytics: as long as Vercel keeps them for our plan.

### Deleting your account

You can delete your account in **Account settings → Delete account**. Before you confirm, the page shows what will happen:

- Your personal pages are deleted, with their history.
- Organizations with nobody else in them are deleted, with their pages.
- Pages you published in organizations with other people stay in those organizations and move to another owner. The organization can keep them.
- Your sessions, passkeys, authenticator app, recovery codes, agent connections, access tokens, memberships, product events, data exports, and shares and invitations to your email address are deleted.
- Comments you wrote stay on pages that remain, shown as "Deleted account". Versions you published stay without your name.

You can't delete your account while you are the only owner of an organization that has other people in it. Make someone else an owner first, or remove the other people.

### Deleting an organization

An organization is deleted with everything in it: its pages, their versions and comments, its folders, memberships, invitations, and the agent connections and access tokens made for it. To delete an organization that still has other people in it, email us from an owner's address.

### Files and backups

When a page or version is deleted, its rows are removed at once. Its files are removed from storage by a cleanup that runs every day, unless another page still uses exactly the same file.

Our database provider keeps backups. Deleted data can stay in those backups until they expire, for up to 30 days. We don't restore deleted data from backups except to recover from an incident.

## Your rights

Under UU PDP you can:

- get information about how we process your data
- get a copy of your data
- correct data that is wrong or incomplete
- delete your data, or ask us to delete it
- withdraw consent you gave
- object to decisions made only by automated processing (we make none)
- ask us to pause or limit processing
- get your data in a format you can use elsewhere
- complain to the authority for personal data protection in Indonesia

Much of this you can do yourself: change your name and sign-in methods in **Account settings**, download any page as a zip file, download a copy of all your data (every page you own with its versions, sharing and comments, and your account, as files and JSON you can use elsewhere) in **Account settings → Export your data** (see [Exporting your data](/docs/exporting-your-data)), and delete pages or your account. For anything else, email [andidev30.personal@gmail.com](mailto:andidev30.personal@gmail.com) from the address on your account. We may ask you to confirm it's you. We reply within the time limits of UU PDP.

If you are in the European Economic Area or the United Kingdom, you have similar rights under the GDPR. Email us in the same way. You can also complain to your local data protection authority. We are a small operator in Indonesia and don't have a representative in the EU or the UK.

## Security

We protect data with HTTPS for every connection, hashed tokens and passwords, encrypted authenticator secrets, and pages that run in a sandbox away from your account. No system is perfectly secure. If a breach puts your personal data at risk, we will tell you and the authority in writing within 3 × 24 hours of finding out, as UU PDP requires.

## Children

The service is not for people under 18, and we don't knowingly collect their data. If you think a child has created an account, email us and we will delete it.

## Changes to this policy

When we change this policy, we update the date at the top. For important changes, we tell you by email or in the app before they apply.

## Contact

Email [andidev30.personal@gmail.com](mailto:andidev30.personal@gmail.com) for privacy questions and data requests.
