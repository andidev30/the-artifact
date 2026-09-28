# SAML single sign-on

**Enterprise feature.** SAML works on a self-hosted install with an Enterprise license key; see [The license](/docs/sso#the-license). It isn't available on the hosted service.

SAML 2.0 is the other protocol [single sign-on](/docs/sso) speaks, next to OpenID Connect: for identity providers (IdPs) and IT teams that set up apps with SAML, such as Okta, Microsoft Entra ID and Google Workspace. A SAML provider is one more **Continue with** button on the sign-in page and works like an OIDC one: the same email domains, organization for new people, **Require single sign-on** and account matching (see [How it works](/docs/sso#how-it-works)). A SAML IdP doesn't say whether it verified an address, so list its email domains for people who already have an account to sign in through it (see [Linking existing accounts](/docs/sso#linking-existing-accounts)). Pair it with [SCIM provisioning](/docs/scim) to create and suspend accounts from the IdP before people sign in.

## What your IdP needs from this server

These two addresses are the same for every SAML provider on the server. **Server admin** > **Single sign-on** shows them with copy buttons.

| This server calls it | What IdPs call it | Value |
| --- | --- | --- |
| **Entity ID** | Audience URI, SP Entity ID, Identifier | `{{APP_URL}}/api/auth/sso/saml/metadata` |
| **ACS URL** | Single sign-on URL, Reply URL, Recipient | `{{APP_URL}}/api/auth/sso/saml/acs` |

The entity ID is also the address of this server's SAML metadata, for IdPs that can read it.

The server reads each person's email address and name from the assertion. It looks for the attributes Okta, Entra ID and Google Workspace send by default (`email`, `firstName` and `lastName`, and the Entra ID `emailaddress`, `givenname`, `surname` and `displayname` claims), then for a NameID that is an email address. If your IdP uses other names, enter them under **Email attribute** and **Name attribute**.

The IdP answers with a form post from its own site, and the browser only keeps the cookie that ties that answer to the sign-in it started over HTTPS (or on `localhost`). Run the server on HTTPS, with `APP_URL` set to its HTTPS address.

## Okta

1. In the Okta Admin Console, go to **Applications**, **Create App Integration**, choose **SAML 2.0**, and name it.
2. Under **Configure SAML**, set **Single sign-on URL** to the ACS URL and **Audience URI (SP Entity ID)** to the entity ID. Leave **Use this for Recipient URL and Destination URL** checked.
3. Set **Name ID format** to `EmailAddress` and **Application username** to `Email`.
4. Under **Attribute Statements**, add `email` → `user.email`, `firstName` → `user.firstName` and `lastName` → `user.lastName`.
5. Finish, then on the app's **Sign On** tab copy the **Metadata URL**.
6. Assign the app to the people or groups who should sign in.

## Microsoft Entra ID

1. In the Entra admin center, go to **Enterprise applications**, **New application**, **Create your own application**, and choose **Integrate any other application you don't find in the gallery**.
2. Open **Single sign-on** and choose **SAML**.
3. Under **Basic SAML Configuration**, set **Identifier (Entity ID)** to the entity ID and **Reply URL (Assertion Consumer Service URL)** to the ACS URL.
4. The default **Attributes & Claims** work. Check that **emailaddress** maps to `user.mail` and that everyone has a mail address.
5. Under **SAML Certificates**, copy the **App Federation Metadata Url**.
6. Under **Users and groups**, assign the people or groups who should sign in.

## Google Workspace

1. In the Google Admin console, go to **Apps**, **Web and mobile apps**, **Add app**, **Add custom SAML app**, and name it.
2. On **Google Identity Provider details**, choose **Download metadata** and keep the file.
3. On **Service provider details**, set **ACS URL** to the ACS URL and **Entity ID** to the entity ID. Set **Name ID format** to `EMAIL` and **Name ID** to **Basic Information > Primary email**.
4. Under **Attribute mapping**, add **First name** → `firstName` and **Last name** → `lastName`.
5. Turn the app on for the organizational units that should sign in (**User access**). It can take a few minutes to apply.

Google gives you a file rather than a URL, so paste its contents into **Or paste the metadata XML** in the next step.

## Add it to the server

In **Server admin** > **Single sign-on**, choose **Add a provider**, choose **SAML**, and fill in:

| Field | What to enter |
| --- | --- |
| **Name on the button** | What people see: "Continue with" and this name, e.g. Okta |
| **Metadata URL** | The IdP's metadata URL. The server downloads it on every save, which also picks up a new signing certificate after the IdP rotates it |
| **Or paste the metadata XML** | The metadata file, for IdPs that only give you one. When editing, leave both empty to keep the IdP as it is |
| **Email attribute**, **Name attribute** | Optional; see [What your IdP needs](#what-your-idp-needs-from-this-server) |
| **Allow sign-in started from the IdP's app dashboard** | Off unless you need it; see [below](#signing-in-from-the-idps-dashboard) |
| **Email domains**, **Organization for new people**, **Require single sign-on**, **Show on the sign-in page** | As for any provider; see [Set it up](/docs/sso#set-it-up) |

When you save, the server reads the metadata and refuses it if it has no sign-in address for the HTTP-Redirect binding or no signing certificate. SAML providers have no **Test connection**; sign in with the button in a private window to try one.

## Signing in from the IdP's dashboard

By default a sign-in has to start on this server: **Continue with …** sends people to the IdP, and only an answer to that request is accepted. **Allow sign-in started from the IdP's app dashboard** also accepts answers the IdP sends on its own, when people click the app's tile in Okta or My Apps. Leave it off unless you need it: such answers can't be tied to the browser that asked for them, so someone could get a person signed in to the wrong account.

## What the server checks

Every answer from the IdP must pass all of these, or sign-in fails with **Single sign-on did not work**:

- The assertion is signed by a certificate from the IdP's metadata. A signed response around an unsigned assertion isn't enough.
- Its issuer is the IdP's entity ID, its audience is this server's entity ID, and its recipient is this server's ACS URL.
- It is within its validity window (a minute of clock difference is allowed) and no more than 10 minutes old.
- It answers a sign-in this server started for that provider in the last 10 minutes, from the same browser.
- It hasn't been used before. The server remembers used assertions until they are too old to accept anyway.

The server logs why it refused an answer (`SAML response refused`, with the reason), which helps when setting up a new IdP. Answers from one network are [rate limited](/docs/configuration#rate-limits) (`saml-ip`), on top of `sso-ip` for starting a sign-in.

## Troubleshooting

| Problem | Check |
| --- | --- |
| There is no button on the sign-in page | The license is active and **Show on the sign-in page** is on |
| **Single sign-on did not work** right after the IdP | The server log's reason. Usually the entity ID or ACS URL at the IdP differs from the ones in **Server admin**, or the IdP's certificate changed: save the provider again |
| **That single sign-on isn't available any more** | The sign-in took longer than 10 minutes, or started in another browser. Start again from the button |
| It works on `localhost` but not on the server | The server is on HTTPS, and `APP_URL` is its HTTPS address |
