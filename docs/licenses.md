# Licenses

A self-hosted install is free under AGPL-3.0 and does everything described in these docs without a license. An Enterprise license key turns on enterprise features on a self-hosted install, such as [version retention](/docs/retention) and [single sign-on](/docs/sso). It says who the license is for, how many seats it has, and until when it is valid.

## Enterprise features

| Feature | What it does |
| --- | --- |
| [Audit log](/docs/audit-log) | Records sign-ins, sharing, member changes, organization settings and access tokens per organization, for its owners and admins to filter and export |
| [Single sign-on](/docs/sso) | People sign in through your identity provider (OpenID Connect or [SAML](/docs/saml)), with accounts made or linked on first sign-in, and sign-in through it can be required |
| [SCIM provisioning](/docs/scim) | Your identity provider creates accounts, keeps them current and suspends people it deactivates |

## Nothing phones home

Your server checks the key itself. The key is signed, and the public keys that check the signature are part of the code, so no request leaves your server to check a license, not when you enter it and not later. An install without internet access checks a key the same way.

## Enter a license key

You need to be an instance admin.

1. Open **Server admin** and go to **License**.
2. Paste the whole key into **License key**. It starts with `art_lic_`. Line breaks from an email don't matter.
3. Select **Save key**.

**License** then shows who the server is licensed to, the contact email, until when it is valid, and the seats in use against the seats of the license.

Your server refuses a key that:

| Problem | What it says |
| --- | --- |
| Isn't a key, or only part of one | This is not a license key. Paste the whole key. |
| Was changed after it was issued | This license key has been changed or is incomplete. |
| Was signed by a key your version doesn't know | Update the server, or ask for a new license key. |
| Has expired | This license key expired on the date it names. Ask for a new license key. |

## Renew or replace a key

Paste the new key into **New license key** and select **Replace key**. The new key takes effect at once. There is nothing to restart.

To remove the key, select **Remove key** and confirm. Enterprise features turn off. Nothing else changes.

## Seats

Every account that isn't suspended uses a seat. When more people have an account than the license has seats, **License** shows a warning. Nobody is locked out and nothing stops working. Ask for a license with more seats.

## When a license expires

A license is valid through the last day it names (UTC). After that:

| When | What happens |
| --- | --- |
| The first 14 days after it expires | Enterprise features stay on. **License** shows a warning with the day they turn off. |
| After those 14 days | Enterprise features turn off. |

Nothing is deleted when a license expires. Pages, accounts, organizations and sharing keep working as on any self-hosted install. Enter a new key and enterprise features turn back on.

## Issue license keys on the hosted service

This section is for the operator of the hosted service. A self-hosted install never needs it.

Instance admins of the hosted service issue keys under **Server admin**, in **License keys**: enter the customer, their email, the seats and the last valid day, then select **Issue key**. The key is shown once. Copy it and send it to the customer. The list below the form shows every key issued, with its customer, seats, dates and who issued it. It doesn't keep the keys themselves.

Issuing needs a signing key. Without one, **License keys** says why you can't issue keys.

### Create the signing key

1. Make a key pair. The command only prints; it needs no database and no other settings:

   ```sh
   pnpm --filter @the-artifact/api license:keygen
   ```

2. Set the private key as `LICENSE_SIGNING_KEY` on the hosted service. It is the only place it goes. Anyone who has it can issue keys that every install accepts.
3. Add the public key line it prints to `LICENSE_PUBLIC_KEYS` in `apps/api/src/license.ts`, and release it. Installs accept keys from this signing key once they run a release that lists it.

The hosted service checks this too: until the public key of `LICENSE_SIGNING_KEY` is in the code it runs, **License keys** doesn't issue keys, because installs would refuse them.

### Rotate the signing key

Make a new key pair, add its public key to `LICENSE_PUBLIC_KEYS` next to the old one, and release. Then set the new private key as `LICENSE_SIGNING_KEY`. Keys signed by the old key keep working as long as its public key stays in the list. Remove an old public key only when every key it signed has expired, or when it leaked; keys it signed then stop working on installs that update.
