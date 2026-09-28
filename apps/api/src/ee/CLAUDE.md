# ee/

Code under `LICENSE-EE` at the repository root (source-available, not AGPL), as in GitLab EE. Everything outside an `ee/` folder is AGPL-3.0.

- Belongs here, kind 1, hosted only: anything that only makes sense when `SELF_HOSTED=false` (marketing site, pricing, contact sales, the hosted onboarding choice, issuing license keys, and later billing and plans). Gate it on `SELF_HOSTED` and add a test that it is off on a self-hosted install.
- Belongs here, kind 2, enterprise features (audit log, version retention, SSO, SCIM): code a self-hosted install runs only with a valid license key. Gate every entry on `hasEnterprise()` or `requireEnterprise` from core `src/license.ts` (API), and add a test that it is off without a license, after the grace period, and on the hosted service. Turning off never deletes data.
- Doesn't belong here: anything a self-hosted install needs without a license, including checking license keys (`src/license.ts` is core). When in doubt it is core.
- Core may reference `ee/` only at its entry points (see the list below). `ee/` may import core freely.

Entry points in the API: `src/app.ts` mounts `ee/licenses.ts` at `/api/admin/issued-licenses` (404 when self-hosted; signs keys with `LICENSE_SIGNING_KEY`) and `ee/contact.ts`, which answers 404 when self-hosted, and sets the Personal plan's limits from `ee/plans.ts` (`setPlanQuota` for its pages and storage, and `/api/cron/history` for pruning old versions), which check `SELF_HOSTED` themselves. `ee/contact.ts` defines its own rate limits with `defineLimit`. Its email lives in `ee/mail.ts`, mocked separately in `test/integration/setup.ts`.
