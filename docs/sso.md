# Single sign-on

**Enterprise feature.** Single sign-on works on a self-hosted install with an Enterprise license key; see [The license](#the-license). It isn't available on the hosted service.

With single sign-on, people sign in through your identity provider (IdP) with OpenID Connect (OIDC): Google Workspace, Microsoft Entra ID, Okta, Keycloak, or any other provider that supports OIDC discovery. The sign-in page shows a **Continue with** button for each provider you turn on.

## How it works

Single sign-on is set up once for the whole server, by an instance admin, under **Server admin** > **Single sign-on**. On a self-hosted install the instance admin is usually the one who runs the identity provider too, and everyone on the server signs in the same way, so there is no setting per organization. Each provider can name an organization that people join as members the first time they sign in through it, typically the server's own organization.

When someone chooses the button:

1. The server sends them to the provider with the authorization code flow, PKCE (`S256`), a `state` and a `nonce`.
2. The provider sends them back to `{{APP_URL}}/api/auth/sso/oidc/callback`. The server checks the `state`, exchanges the code with the client secret and the PKCE verifier, and checks the ID token: its signature against the provider's published keys (JWKS), its issuer, audience, expiry and `nonce`.
3. The server finds the account:
   - the account this person signed in to through this provider before, found by the provider's stable id for them (`sub`), even if their address changed since;
   - otherwise the account with the same email address, which is then linked to the provider. This needs the provider to say the address is verified (`email_verified`);
   - otherwise a new account.
4. As with every other way in, an account with a passkey or an authenticator app is asked for it next (see [Two-factor sign-in](/docs/signing-in#two-factor-sign-in)).

New accounts follow these rules:

| The provider lists email domains | New accounts at those domains |
| --- | --- |
| Yes | Are created whatever the [sign-up policy](/docs/self-hosting#sign-up-policy) says: the provider vouches for them |
| No | Follow the sign-up policy, like any other sign-up |

Addresses outside a provider's domains can't sign in through it at all.

## Set it up

1. At your provider, create an OIDC application of the web (confidential) kind, with:
   - **Redirect URI**: `{{APP_URL}}/api/auth/sso/oidc/callback` (also shown under **Server admin** > **Single sign-on**, with a copy button)
   - **Grant type**: authorization code
   - **Scopes**: `openid`, `email`, `profile`
2. Note the issuer URL, the client ID and the client secret.
3. In **Server admin** > **Single sign-on**, choose **Add a provider** and fill in:

| Field | What to enter |
| --- | --- |
| **Name on the button** | What people see: "Continue with" and this name, e.g. Okta |
| **Issuer URL** | The provider's issuer. The server reads its settings from the issuer plus `/.well-known/openid-configuration` when you save, so a wrong URL shows up right away. It must start with `https://` |
| **Client ID** and **Client secret** | From step 2. The secret is stored encrypted and never shown again; leave it empty when editing to keep it |
| **Email domains** | The domains your provider signs people in for, e.g. `acme.com`. Recommended; see [New accounts](#how-it-works) |
| **Organization for new people** | An organization they join as members the first time they sign in through this provider. Someone an organization admin removes later isn't added back |
| **Trust addresses the provider doesn't mark as verified** | Off unless your provider never sends `email_verified`; see [Microsoft Entra ID](#microsoft-entra-id) |
| **Require single sign-on for these addresses** | See [Requiring single sign-on](#requiring-single-sign-on) |
| **Show on the sign-in page** | Leave it off until the test below works |

4. Choose **Test connection** on the provider's row. You go through the provider's sign-in and come back to **Server admin**, which shows the address, name and id the provider sent and whether that person would get in. Nobody is signed in and no account is created or linked by the test.
5. Choose **Edit**, turn on **Show on the sign-in page**, and save.

The server itself must reach the provider's issuer URL, token endpoint and keys over the network; people's browsers must reach its sign-in page.

## Providers

### Google Workspace

1. In the Google Cloud console, open **APIs & Services** > **OAuth consent screen** and choose **Internal** as the user type, so only accounts of your Workspace can sign in.
2. Under **Credentials**, choose **Create credentials** > **OAuth client ID**, type **Web application**, and add the redirect URI under **Authorized redirect URIs**.
3. In **Server admin**, use:

| Field | Value |
| --- | --- |
| **Issuer URL** | `https://accounts.google.com` |
| **Email domains** | Your Workspace domains, e.g. `acme.com` |

Every Google account has the same issuer, so list your domains: without them, anyone with a Google account whom your consent screen lets through could sign in. If you use Google sign-in (`GOOGLE_CLIENT_ID`) already, you can keep it; single sign-on adds the domain rules, the organization and requiring it.

### Microsoft Entra ID

1. In the Entra admin center, open **App registrations** > **New registration**. Choose **Accounts in this organizational directory only**, and add the redirect URI as a **Web** platform.
2. Under **Certificates & secrets**, add a client secret and copy its **Value**.
3. Under **Token configuration**, choose **Add optional claim** > **ID** > **email**. Without it the ID token has no address.
4. In **Server admin**, use:

| Field | Value |
| --- | --- |
| **Issuer URL** | `https://login.microsoftonline.com/<tenant id>/v2.0`, with your directory (tenant) ID from the app's **Overview** |
| **Client ID** | The **Application (client) ID** |
| **Email domains** | Your verified domains in Entra, e.g. `acme.com` |
| **Trust addresses the provider doesn't mark as verified** | On |

Entra ID doesn't send `email_verified`, so the server can't tell whether it checked an address; turning on **Trust addresses** accepts its addresses as they are. Only do this with the tenant-specific issuer above (not `common` or `organizations`) and with your domains listed, so only addresses your IT team controls can sign in.

### Okta

1. In the Okta admin console, open **Applications** > **Create App Integration**, and choose **OIDC - OpenID Connect** and **Web Application**.
2. Add the redirect URI under **Sign-in redirect URIs**, keep **Authorization Code** as the grant type, and assign the people or groups who may sign in.
3. In **Server admin**, use:

| Field | Value |
| --- | --- |
| **Issuer URL** | `https://<your Okta domain>` for the org authorization server, or `https://<your Okta domain>/oauth2/default` for the default custom one |
| **Client ID** and **Client secret** | From the app's **General** tab |

### Keycloak

1. In your realm, open **Clients** > **Create client**, type **OpenID Connect**, and give it a client ID.
2. Turn on **Client authentication**, keep **Standard flow** on, and add the redirect URI under **Valid redirect URIs**.
3. Copy the secret from the client's **Credentials** tab.
4. In **Server admin**, use:

| Field | Value |
| --- | --- |
| **Issuer URL** | `https://<keycloak host>/realms/<realm>` |

Keycloak sends `email_verified` from each user's **Email verified** setting. People whose address isn't marked verified there can't sign in until it is.

## Requiring single sign-on

Turn on **Require single sign-on for these addresses** on a provider to make it the only way in for people at its email domains, or for everyone when it lists none. For those people:

- signing in with a password, an email link, Google or a passkey takes them back to the sign-in page with a message to use single sign-on;
- creating a password account at those domains, on a server without email, is refused.

It changes nothing for:

- **Instance admins.** They can always sign in the other ways, so a broken or unreachable provider never locks the server's admins out. Keep a password, a passkey or email sign-in working for at least one admin.
- **Sessions already open**, until they end or the person signs out, and **agents and access tokens**, which keep working. To cut someone off, suspend them under **Server admin** > **People**.

## The license

Single sign-on is on while the server's license is active, and for the 14 days of grace after it expires; see [Licenses](/docs/licenses) for entering and renewing a key under **Server admin** > **License**. Without a license, or after the grace period:

- the **Continue with** buttons leave the sign-in page, and sign-ins through a provider stop, including ones halfway through;
- **Require single sign-on** no longer applies, so people sign in the other ways they have: an email link (on servers that send email), a password, a passkey or Google. On a server without email, someone who only ever used single sign-on needs a sign-in link from an admin (**Server admin** > **People**);
- **Server admin** > **Single sign-on** says a license is needed.

Nothing is deleted: accounts, their links to the provider and the provider settings stay, and single sign-on comes back as it was with a new license key.

## Security notes

- The client secret is encrypted at rest (AES-256-GCM) with a key the server keeps in its `server_secrets` table, like authenticator app secrets. A full database backup holds both, so protect backups like the database.
- The redirect URI is built from `APP_URL`, never from the request's `Host` header, and the page people return to after signing in is always on this server.
- Addresses link to existing accounts only when the provider says they are verified, or when you turned on **Trust addresses** for it. Anyone who controls the provider can sign in as any account at its domains, instance admins included; treat admin access to the provider like admin access to this server.
- Issuer URLs must use HTTPS. Plain HTTP is accepted only while `APP_URL` is HTTP too, for trying it locally.
- Starting and finishing single sign-on is rate limited per network (`sso-ip` under [Rate limits](/docs/configuration#rate-limits)).
