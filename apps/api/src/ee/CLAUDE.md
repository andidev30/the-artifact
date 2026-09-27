# ee/

Code for the hosted service only, under `LICENSE-EE` at the repository root (source-available, not AGPL). Everything outside an `ee/` folder is AGPL-3.0.

- Belongs here: anything that only makes sense when `SELF_HOSTED=false` (marketing site, pricing, contact sales, the hosted onboarding choice, and later billing and plans).
- Doesn't belong here: anything a self-hosted install needs. When in doubt it is core.
- Core may reference `ee/` only at its entry points (see the list below). `ee/` may import core freely.
- Every `ee/` feature is inert on a self-hosted install: gate it on `SELF_HOSTED`, and add a test that it is off there.

Entry points in the API: `src/app.ts` mounts `ee/contact.ts`, which answers 404 when self-hosted. Its email lives in `ee/mail.ts`, mocked separately in `test/integration/setup.ts`.
