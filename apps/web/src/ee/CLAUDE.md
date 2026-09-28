# ee/

Code under `LICENSE-EE` at the repository root (source-available, not AGPL), as in GitLab EE. Everything outside an `ee/` folder is AGPL-3.0.

- Belongs here, kind 1, hosted only: anything that only makes sense when `SELF_HOSTED=false` (marketing site, pricing, contact sales, the hosted onboarding choice, issuing license keys, and later billing and plans). Gate it on `SELF_HOSTED` and add a test that it is off on a self-hosted install.
- Belongs here, kind 2, enterprise features (audit log, version retention, SSO, SCIM): code a self-hosted install runs only with a valid license key. Gate every entry on `hasEnterprise()` or `requireEnterprise` from `apps/api/src/license.ts`; in the web app, hide it unless the API says it is on, and add a test that it is off without a license, after the grace period, and on the hosted service. Turning off never deletes data.
- Doesn't belong here: anything a self-hosted install needs without a license, including checking license keys (`apps/api/src/license.ts` is core). When in doubt it is core.
- Core may reference `ee/` only at its entry points (see the list below). `ee/` may import core freely.

Entry points in the web app: `pages/Home.tsx` lazy-loads `Landing` and `ContactSales` only when the install is not self-hosted, so their code and CSS (`Landing.css`) never load there; `pages/Onboarding.tsx` shows `WorkspaceChoice` on the hosted service only; `pages/Admin.tsx` lazy-loads `IssueLicenses` (issuing license keys) on the hosted service only.
