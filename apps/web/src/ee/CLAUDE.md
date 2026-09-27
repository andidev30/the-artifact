# ee/

Code for the hosted service only, under `LICENSE-EE` at the repository root (source-available, not AGPL). Everything outside an `ee/` folder is AGPL-3.0.

- Belongs here: anything that only makes sense when `SELF_HOSTED=false` (marketing site, pricing, contact sales, the hosted onboarding choice, and later billing and plans).
- Doesn't belong here: anything a self-hosted install needs. When in doubt it is core.
- Core may reference `ee/` only at its entry points (see the list below). `ee/` may import core freely.
- Every `ee/` feature is inert on a self-hosted install: gate it on `SELF_HOSTED`, and add a test that it is off there.

Entry points in the web app: `pages/Home.tsx` lazy-loads `Landing` and `ContactSales` only when the install is not self-hosted, so their code and CSS (`Landing.css`) never load there; `pages/Onboarding.tsx` shows `WorkspaceChoice` on the hosted service only.
