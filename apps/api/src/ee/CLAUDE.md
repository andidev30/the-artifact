# ee/

Code under `LICENSE-EE` at the repository root (source-available, not AGPL), as in GitLab EE. Everything outside an `ee/` folder is AGPL-3.0.

- Belongs here, kind 1, hosted only: anything that only makes sense when `SELF_HOSTED=false` (marketing site, pricing, contact sales, the hosted onboarding welcome, issuing license keys, and later billing and plans). Gate it on `SELF_HOSTED` and add a test that it is off on a self-hosted install.
- Belongs here, kind 2, enterprise features (audit log, version retention, SSO, SCIM): code a self-hosted install runs only with a valid license key. Gate every entry on `hasEnterprise()` or `requireEnterprise` from core `src/license.ts` (API), and add a test that it is off without a license, after the grace period, and on the hosted service. Turning off never deletes data.
- Doesn't belong here: anything a self-hosted install needs without a license, including checking license keys (`src/license.ts` is core). When in doubt it is core.
- Core may reference `ee/` only at its entry points (see the list below). `ee/` may import core freely.

Entry points in the API: `src/app.ts` mounts `ee/licenses.ts` at `/api/admin/issued-licenses` (404 when self-hosted; signs keys with `LICENSE_SIGNING_KEY`) and `ee/contact.ts`, which answers 404 when self-hosted, and sets the Personal plan's limits from `ee/plans.ts` (`setPlanQuota` for its pages and storage, and `/api/cron/history` for pruning old versions), which check `SELF_HOSTED` themselves. It also sets `organizationPlan` from `ee/plans.ts` with `setOrganizationPolicy` (`routes/organizations.ts`): until the Organization plan has billing (#34), the hosted service refuses new organizations with a 403, and `/api/config` reports `newOrganizations: false`. `ee/contact.ts` defines its own rate limits with `defineLimit`. Its email lives in `ee/mail.ts`, mocked separately in `test/integration/setup.ts`.

Enterprise features that a license key unlocks on a self-hosted install (`hasEnterprise()` in `src/license.ts`) live here too. `src/app.ts` mounts `ee/retention.ts` (version retention per organization) at `/api/organizations/:orgId/retention` and registers its `pruneRetention` with `addPruner` from `src/gc.ts`, which runs it before every storage sweep. It checks the license itself and does nothing on the hosted service or without a license.

The audit log (`ee/audit.ts`) is an enterprise feature too. Core only calls `audit(event)` from `src/audit.ts`, which does nothing until `src/app.ts` plugs the store in with `setAuditStore`; the store checks the license itself, so nothing is recorded on the hosted service or without a license. `app.ts` mounts its routes at `/api/organizations/:orgId/audit-log` and registers `pruneAuditEvents` with `addPruner`.
