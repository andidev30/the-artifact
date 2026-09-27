---
name: db-migration
description: Change the Postgres schema of apps/api safely - edit schema.ts, generate and name the Drizzle migration, update code and tests. Use for any new table, column, index or constraint.
---

# Schema change

1. Edit `apps/api/src/db/schema.ts`. Follow the file: snake_case column names, `uuid` ids with `defaultRandom()` (tables keyed by a hashed token use the hash as a `text` id), `timestamp(..., { withTimezone: true })`, `onDelete` spelled out on every foreign key, a short comment only when the column's meaning isn't obvious.
2. Make sure `apps/api/.env` points at the dev database and it is up (`pnpm services`), then `pnpm db:generate`.
3. Read the generated `apps/api/drizzle/NNNN_*.sql`:
   - It must be safe on a database with data: new `NOT NULL` columns need a default or a backfill step in the same file.
   - If the name is random (`0011_brave_xyz.sql`), rename it to what it does (`0011_page_labels.sql`) and change the matching `tag` in `drizzle/meta/_journal.json`.
4. Never edit a migration that is already committed on `main`; add another one.
5. `pnpm db:migrate`, then update the code that reads and writes the table.
6. Deleting accounts, organizations or pages must still clean up: check `deleteAccountData` in `src/routes/settings.ts`, the admin deletes in `src/routes/admin.ts`, and that new blob references are known to `sweepStorage` in `src/gc.ts`.
7. Run `pnpm lint` and `pnpm --filter @the-artifact/api test:integration` (tests migrate `artifact_test` themselves).
8. Commit the SQL, the snapshot in `drizzle/meta/` and the journal together.

Self-hosted installs apply migrations on start (`MIGRATE_ON_START=true` in the image), so a migration that fails blocks every upgrade.
