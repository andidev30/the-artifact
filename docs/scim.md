# SCIM provisioning

**Enterprise feature.** Your identity provider (IdP) creates accounts on a self-hosted server, keeps names and email addresses current, and suspends people it deactivates, over SCIM 2.0. It works with Okta and Microsoft Entra ID, and with other IdPs that follow the standard. People then sign in with [single sign-on](/docs/sso) (OpenID Connect or [SAML](/docs/saml)) or any other way the server offers.

## Before you start

- A self-hosted server with an Enterprise license, added by an instance admin under **Server admin** (see [Enter a license key](/docs/licenses#enter-a-license-key)). Without one, the SCIM endpoint answers `403`, and **Server admin** > **Provisioning (SCIM)** says a license is needed. When a license expires, SCIM keeps working for 14 more days, then stops; accounts stay as they are.
- The server reachable from your IdP over HTTPS. Okta and Entra ID call it from the internet.

The hosted service doesn't offer SCIM yet.

## Make a token

Open **Server admin**, then **Provisioning (SCIM)**:

1. Copy the **SCIM base URL**: `{{APP_URL}}/scim/v2`.
2. Enter a **Token name**, such as the IdP's name, and choose what it reaches under **Organization**:
   - **An organization**: the token lists and manages only that organization's members, and accounts it creates join it as members. Use this when the IdP belongs to one organization on a server that others share.
   - **Every account on this server**: the token manages every account, and accounts it creates start in a personal workspace. Use this when the IdP is the server's own directory.
3. Choose **Make token** and copy it. It is shown once, and the server keeps only a hash of it.

Each token shows when it was last used. **Revoke** stops it at once; make a new one to replace it.

## Okta

1. Open the app integration you use for [SAML](/docs/saml#okta). On **General**, under **App Settings**, choose **Edit**, select **SCIM** as the provisioning method, and save.
2. On the new **Provisioning** tab, under **Integration**, set **SCIM connector base URL** to the SCIM base URL and **Unique identifier field for users** to `userName`.
3. Check **Push New Users**, **Push Profile Updates** and **Import New Users and Profile Updates**. Leave **Push Groups** unchecked.
4. Set **Authentication Mode** to **HTTP Header** and paste the token as the **Bearer** token. Choose **Test Connector Configuration**, then **Save**.
5. Under **To App**, choose **Edit** and turn on **Create Users**, **Update User Attributes** and **Deactivate Users**.

## Microsoft Entra ID

1. Open the enterprise application you use for [SAML](/docs/saml#microsoft-entra-id) and go to **Provisioning**. Set **Provisioning Mode** to **Automatic**.
2. Under **Admin Credentials**, set **Tenant URL** to the SCIM base URL and **Secret Token** to the token. Choose **Test Connection**, then **Save**.
3. Under **Mappings**, turn off **Provision Microsoft Entra ID Groups**. In the user mapping, keep `userPrincipalName` → `userName` (or use `mail` if your UPNs aren't email addresses) and `mail` → `emails[type eq "work"].value`.
4. Set **Provisioning Status** to **On**. Entra ID provisions in cycles, about every 40 minutes; use **Provision on demand** to try one person at once.

## What the IdP can do

| The IdP | What happens here |
| --- | --- |
| Creates a user | A new account with the user's work email as its address (or the `userName`, when it is an email address). It joins the token's organization. |
| Looks a user up (`userName eq "…"`) | Accounts are matched by `userName`, ignoring case. Accounts that existed before SCIM match by their email address, so the IdP links them instead of making a second one. A token for an organization finds only its members: invite people who already have an account to the organization first, or creating them answers `409`. |
| Updates a user (`PUT` or `PATCH`) | The name and email address change. Changing the address changes what the person signs in with. |
| Deactivates a user (`active: false`) | The account is suspended and signed out everywhere, including agents and access tokens, as when an admin suspends it. Setting `active: true` restores it. |
| Deletes a user | The same as deactivating. The account and its pages stay, and an instance admin can restore or delete it under **Server admin**. |

Only users are supported. SCIM Groups answer `404`: turn off group push in the IdP, and manage organizations and their members in the app.

SCIM can't deactivate the only instance admin; make someone else an admin first. Users created over SCIM never become instance admins on their own.

### What a token for an organization reaches

A token for an organization only sees that organization's members; any other account answers `404`, as if it didn't exist. Suspending an account or changing its name or email address reaches beyond the organization (the person's own pages, other organizations they are in, the server), so the token does that only for members who are in no other organization and aren't instance admins. For everyone else:

- Changes to the name and email address are ignored; the request still succeeds.
- Deactivating or deleting them removes them from the organization instead, as when an owner removes them: their agents and access tokens for it stop working, and their account and other organizations stay. The organization's only owner can't be removed this way. Once removed, they are no longer the token's to manage; invite them again to bring them back.

Only an instance admin can make SCIM tokens, including tokens for every account.

## Details for other IdPs

| | |
| --- | --- |
| Base URL | `{{APP_URL}}/scim/v2` |
| Authentication | `Authorization: Bearer <token>` |
| Resources | `/Users` (`GET`, `POST`), `/Users/{id}` (`GET`, `PUT`, `PATCH`, `DELETE`), `/ServiceProviderConfig`, `/ResourceTypes` |
| Filters | `eq` on `userName`, `externalId`, `id` and `emails` |
| Paging | `startIndex` and `count`, at most 200 per page |
| Attributes kept | `userName`, `name.givenName`, `name.familyName`, `name.formatted`, `displayName`, the primary or work email, `active`, `externalId`. Others are accepted and ignored. |

Errors follow RFC 7644: `{"schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "409", "scimType": "uniqueness", "detail": "…"}`. One token can make 2,000 requests per 10 minutes (the `scim` [rate limit](/docs/configuration#rate-limits)), which a full import stays well under.
