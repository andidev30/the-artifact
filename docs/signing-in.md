# Signing in

You sign in with an email link, a password (on servers that don't send email), Google, or a passkey. Add a passkey or an authenticator app and signing in asks for it as well, so someone who learns your password or gets into your email still can't sign in as you.

Everything here is in **Account settings**, under **Sign-in security** and **Sessions**.

## Single sign-on

On a server set up for [single sign-on](/docs/sso), the login page has a **Continue with** button for your organization's identity provider, such as Okta or Microsoft Entra ID. It signs you in to the account with your work address, and creates one the first time if you don't have one yet. If the server requires single sign-on for your address, the other ways in send you back to that button.

## Two-factor sign-in

Two-factor sign-in is on once your account has a passkey or an authenticator app. After your password, email link, Google or single sign-on, the app shows **Confirm it’s you** and asks for one of them. You are signed in only after that step, and the step has to be finished within 10 minutes.

| You sign in with | Also asked for |
| --- | --- |
| A password | A passkey, a code from your authenticator app, or a recovery code |
| An email link, including one an admin gave you | The same |
| Google | The same |
| Single sign-on | The same |
| A passkey on its own | Nothing: the passkey is something you have, and unlocking it (fingerprint, face, PIN) is something you are or know |

Changes under **Sign-in security** need a sign-in from the last hour. If yours is older, choose **Sign in again** first. This keeps someone who got hold of a browser where you are signed in from adding their own passkey or taking your recovery codes.

## Passkeys

A passkey is a key your device keeps for this server, unlocked with your fingerprint, face or device PIN: Touch ID or Face ID, Windows Hello, Android, a password manager such as 1Password or iCloud Keychain, or a security key such as a YubiKey. Nothing secret leaves the device, and a passkey only works on the address it was made for, so a look-alike site can't use it.

To add one, give it a name under **Passkeys** (the device, like "MacBook") and choose **Add a passkey**. Your browser asks you to confirm. You can add up to 20, for example one per device, and rename or remove them later. Each shows whether it is synced across your devices and when it was last used.

To sign in with one, choose **Sign in with a passkey** on the login page. You don't need to type your email; the browser offers the passkeys it has for this server.

## Authenticator app

Any app that makes 6-digit codes works: 1Password, Google Authenticator, Microsoft Authenticator, Authy and others. Under **Authenticator app**, choose **Set up**, scan the QR code with the app (or type in the key under it), and enter the code the app shows to turn it on.

A code works once. If one is refused, wait for the next one. Codes from a phone whose clock is up to 30 seconds off still work; if they keep failing, set the phone's time to update automatically.

## Recovery codes

The first time you add a passkey or an authenticator app, you get 10 recovery codes. They are shown once: copy or download them and keep them somewhere safe, apart from your phone, such as a password manager or on paper. On **Confirm it’s you**, choose **Use a recovery code** and enter one when you can't use your passkey or app. Each code works once. **Sign-in security** shows how many are left.

**Make new codes** replaces all of them, and the old ones stop working. Removing your last passkey and the authenticator app turns two-factor sign-in off and deletes the recovery codes.

## Sessions

**Sessions** lists every browser where you are signed in, with the browser and system, when it signed in and when it was last active. **Sign out** ends one; **Sign out other devices** ends every one but this. A session lasts 30 days and is extended while you use it.

Changing your password signs out every other device. Adding a passkey or an authenticator app doesn't; if you added one because you think someone else could sign in, choose **Sign out other devices** as well.

## Organizations that require it

Owners and admins can make two-factor sign-in a requirement for their organization (see [Organizations and members](/docs/organizations#requiring-two-factor-sign-in)). If you are a member without a passkey or an authenticator app, the app takes you to **Sign-in security** when you sign in, and you can't open the organization's pages or settings in the app until you add one (pages shared with you directly or by link still open). Agents you connected and access tokens you made for it stop working until then, and start again once you add one. Leaving the organization still works.

## If you lose your second factor

Sign in with a recovery code, then remove the lost passkey or set up the authenticator app again, and make new recovery codes.

Without a recovery code, ask an admin of this server. After making sure it is really you, they choose **Reset two-factor sign-in** under **Server admin**, **People**. It removes every passkey, the authenticator app and the recovery codes, and signs you out everywhere. You then sign in with your password, an email link or Google alone, and set up two-factor sign-in again. Nobody else, including organization owners, can turn it off for you, and an email link doesn't skip it.
