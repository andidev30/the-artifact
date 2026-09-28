# Hosted service runbook

On-call notes for the hosted service at https://the-artifact-pi.vercel.app. Self-hosted installs don't need any of this: their backups are in `docs/backups.md` (shown in the app at `/docs/backups`), and this file is deliberately outside `docs/` so it never ships inside the app.

## What runs where

| Part | Where | Notes |
| --- | --- | --- |
| Web app | Vercel, static files from `apps/web/dist` | `vercel.json` |
| API, MCP, OAuth | One Vercel function, `api/index.js`, region `hnd1` (Tokyo) | Imports the `tsc` output of `apps/api`. Doesn't run migrations |
| Scheduled jobs | Vercel crons: `/api/cron/history` 18:30 UTC, `/api/cron/sweep` 19:00 UTC | Need `CRON_SECRET` in Vercel |
| Postgres | Supabase, reached through the transaction pooler (port 6543, `DATABASE_PREPARE=false`) | Data API is off |
| Page content | Supabase Storage, private bucket, S3 protocol | Objects under `blobs/<sha256>` |
| Page files in the browser | The same Vercel project on a second alias, `https://the-artifact-content.vercel.app`, set as `CONTENT_ORIGIN` (Production) | `vercel.app` is on the Public Suffix List, so the alias is another site and the app's cookies never reach it. `vercel.json` redirects everything but `/api/` on that host to the app; change the host there if the alias changes |
| Email | Brevo SMTP (`smtp-relay.brevo.com:587`) | |
| Backups | GitHub Actions in the private repository [andidev30/the-artifact-backups](https://github.com/andidev30/the-artifact-backups): **Hosted backup** nightly, **Hosted restore test** weekly | See [Backups](#backups) |

Health checks, both public and uncached:

- `GET /healthz` answers `{"status":"ok"}` whenever the function runs.
- `GET /readyz` also checks Postgres and the bucket; 503 with `{"ready":false,"checks":{…}}` when either fails. The reason is only in the logs (`Readiness check failed`).

## Logs

| What | Where |
| --- | --- |
| API requests and errors | Vercel dashboard → the project → **Logs** (filter by status, path or `level:error`). From a terminal: `vercel logs https://the-artifact-pi.vercel.app`. Each line is one JSON object with a request id; the same id is in the `X-Request-Id` response header, so ask the person reporting a problem for it. Vercel keeps runtime logs only for a short time that depends on the plan, so copy what you need while it is there |
| Build failures | Vercel dashboard → **Deployments** → the deployment → **Build Logs** |
| Cron runs | Vercel dashboard → **Settings** → **Cron Jobs** → **View Logs** |
| Postgres, pooler, storage | Supabase dashboard → **Logs & Analytics** (Postgres, Pooler, Storage). Slow queries: **Database** → **Query Performance** |
| Backups and restore tests | GitHub → andidev30/the-artifact-backups → **Actions** → **Hosted backup** / **Hosted restore test**; each run's summary has the result |
| Email delivery | Brevo dashboard → **Transactional** → **Logs** |

## Rolling back a release

Every push to `main` deploys to production. To go back:

1. Vercel dashboard → **Deployments**, find the last good production deployment, open its menu and choose **Instant Rollback** (the CLI equivalent is `vercel rollback <deployment-url>`). It takes seconds and doesn't rebuild. On the Hobby plan it only offers the previous production deployment; to go further back, choose **Promote** (or `vercel promote <deployment-url>`) on an older production deployment.
2. While rolled back, new pushes to `main` build but don't go live. Once the fix is merged and its deployment is good, choose **Undo Rollback**, or **Promote** the new deployment.
3. Revert the bad commit on `main` (`git revert`, PR, merge) so the next deployment doesn't bring it back.

A rollback only changes code. If the bad release ran a migration, read the next section first: the older code has to work with the newer schema.

## Rolling back a migration

Migrations only go forward (Drizzle has no down migrations), and the Vercel function never runs them. **Hosted migrate** (`.github/workflows/hosted-migrate.yml`) does, **when a server release is published** (the Release workflow calls it after tagging `vX.Y.Z`), or when run by hand: it counts the migrations the database hasn't applied, and when there are any it backs up the database (kept as the `database-before-migrate` artifact for 90 days) and runs `pnpm db:migrate` with `HOSTED_DATABASE_URL`. A run without a new migration finishes in about a minute. **Merges to `main` don't deploy**: production runs releases, and every deployment counts against Vercel's 100 a day. A merged change reaches the hosted service with the next release, or earlier if you run the workflow by hand.

Vercel doesn't deploy `main` by itself: `vercel.json` turns git deployments off (pull request previews too: they used up the Hobby plan's 100 deployments a day), and the workflow's last step starts the production deployment through a Vercel deploy hook (`VERCEL_DEPLOY_HOOK`, made with `vercel deploy-hooks create after-migrate --ref main`), only after the migrations are in. A failed migration leaves the previous deployment live. Pull requests get no Vercel preview; CI tests them. To preview a branch by hand, run `vercel deploy` from a checkout of it. To deploy `main` between releases (a hotfix), or to redeploy, run the workflow by hand: `gh workflow run hosted-migrate.yml`. The hook always deploys the newest commit on `main`, and Vercel skips it when that commit is already deployed; for a change to environment variables alone, use `vercel redeploy <production deployment URL> --target production`. If the hook URL leaks, anyone can start deployments of `main`: remove it with `vercel deploy-hooks remove <id>`, make a new one and set the secret again.

To run migrations by hand (a failed run, or before the workflow existed), use a checkout of the release and Supabase's **session** pooler URL (port 5432). Back up first with `gh workflow run hosted-backup.yml -R andidev30/the-artifact-backups`, then `gh run watch -R andidev30/the-artifact-backups`:

```sh
DATABASE_URL='postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' pnpm db:migrate
```

When a migration causes trouble:

1. **It only adds tables, columns or indexes** (most do). The previous release ignores them, so roll the code back as above and leave the schema. Fix forward with a new migration later.
2. **It changed or removed something the previous release uses.** Write a new migration that puts it back (never edit or delete a shipped one), merge it, and run `pnpm db:migrate` again. Roll the code back only after that.
3. **It lost or damaged data.** Restore the backup taken before the migration into a new Supabase project (see [Restoring](#restoring)), check it, then point Vercel at it. Anything written since that backup is lost unless you copy it across by hand.

## Backups

Both backup workflows live in the private repository [andidev30/the-artifact-backups](https://github.com/andidev30/the-artifact-backups), so only its collaborators can download the backups. They check out this repository's `main` branch and run the scripts under `ee/ops/backup/`, which stay here.

**Hosted backup** (`hosted-backup.yml` there) runs every night at 20:20 UTC and on demand:

1. `ee/ops/backup/backup-db.sh` runs `pg_dump --format=custom` of the `public` and `drizzle` schemas (the app's tables and its migration log; Supabase's own schemas are left out so the dump restores into any Postgres) and encrypts it with [age](https://age-encryption.org) on the runner.
2. `ee/ops/backup/backup-bucket.sh` copies everything under `blobs/` in the bucket, then tars, compresses and encrypts it. The database goes first: blobs never change, so a copy taken afterwards has everything the dump refers to.
3. Both are uploaded as workflow artifacts (`database` and `bucket`) kept 90 days.

The job only holds the age **public** key. The private key is needed only to restore, by the restore test and by a person.

**Hosted restore test** (`hosted-restore-test.yml` there) runs every Monday at 21:40 UTC and on demand. It downloads the newest successful backup, decrypts it, restores it into an empty Postgres 17 container, runs `pnpm db:migrate` (which also proves the next release's migrations apply to real data), and runs `ee/ops/backup/verify.sh`: every migration applied, row counts of the main tables, and every blob the database refers to present in the bucket copy. The run summary records the date, the backup it used and its age, the encrypted size, the time taken and each check. It fails when a check fails or when the newest backup is more than 48 hours old, and GitHub emails the owner about a failed scheduled run.

### Why a private repository

Workflow artifacts need no setup (the workflow's own token uploads them) and expire by themselves, up to 90 days. In a public repository anyone signed in to GitHub can download them, which is why the backups moved from this repository to a private one. They are still encrypted with age, so a leaked file is unreadable without the private key; only its name, size and date show. Keep the private key out of both repositories except as the `BACKUP_AGE_IDENTITY` secret.

The one backup still made here is the one **Hosted migrate** takes before a migration (`database-before-migrate`), because that workflow runs in this repository with the release. It is encrypted the same way.

Limits to watch:

- Artifacts in a private repository count against the account's Actions storage: 500 MB on GitHub Free. The bucket copy is a full copy every night, so 90 of them are 90 times the bucket. Past a few hundred MB, lower `retention-days` or switch the bucket to an incremental copy (e.g. `rclone copy` into a private R2 or B2 bucket with its own versioning).
- Actions minutes in a private repository count too (2,000 a month on GitHub Free); a backup takes about a minute and a restore test a few.
- Supabase's own daily backups (paid plans, **Database** → **Backups**) are a second line, not a replacement: they go if the Supabase account does.

### Setting the secrets

Both workflows skip themselves until their secrets exist. Set them in the backups repository with the GitHub CLI (`-R andidev30/the-artifact-backups`); `gh secret set NAME` prompts for the value, so it doesn't land in the shell history. **Hosted migrate** in this repository needs `HOSTED_DATABASE_URL` and `BACKUP_AGE_RECIPIENT` here as well.

1. Make an age key pair on your own machine (`brew install age` or `apt install age`):

   ```sh
   age-keygen -o artifact-backup.key
   ```

   It prints the public key (`age1…`). Store `artifact-backup.key` in the password manager; without it no backup can be read. Then:

   ```sh
   gh secret set BACKUP_AGE_RECIPIENT -R andidev30/the-artifact-backups --body 'age1…'
   gh secret set BACKUP_AGE_RECIPIENT --body 'age1…'   # for Hosted migrate, in this repository
   gh secret set BACKUP_AGE_IDENTITY -R andidev30/the-artifact-backups < artifact-backup.key
   ```

2. The database. Supabase dashboard → **Connect** → **Session pooler** (port 5432). Not the direct connection, which is IPv6 only and GitHub's runners can't reach it, and not the transaction pooler on 6543, which `pg_dump` can't use:

   ```sh
   gh secret set HOSTED_DATABASE_URL -R andidev30/the-artifact-backups
   gh secret set HOSTED_DATABASE_URL   # the same value, for Hosted migrate; postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

3. The bucket. Supabase dashboard → **Storage** → **S3 Configuration**: the endpoint and region are shown there; make a new access key for backups under **S3 Access Keys** rather than reusing the app's, so it can be revoked on its own:

   ```sh
   gh secret set HOSTED_S3_ENDPOINT -R andidev30/the-artifact-backups           # https://<project-ref>.supabase.co/storage/v1/s3
   gh secret set HOSTED_S3_REGION -R andidev30/the-artifact-backups             # e.g. ap-northeast-1
   gh secret set HOSTED_S3_BUCKET -R andidev30/the-artifact-backups             # the bucket name, the app's S3_BUCKET
   gh secret set HOSTED_S3_ACCESS_KEY_ID -R andidev30/the-artifact-backups
   gh secret set HOSTED_S3_SECRET_ACCESS_KEY -R andidev30/the-artifact-backups
   ```

4. Run both once to check: `gh workflow run hosted-backup.yml -R andidev30/the-artifact-backups`, wait for it (`gh run watch -R andidev30/the-artifact-backups`), then `gh workflow run hosted-restore-test.yml -R andidev30/the-artifact-backups` and read its summary.

If the Supabase project runs a Postgres newer than 17 (**Settings** → **Infrastructure**), raise `PG_MAJOR` in both backup workflows and in `hosted-migrate.yml`, and the `postgres` image in the restore test; `pg_dump` refuses to dump a newer server.

### Restoring

You need `age`, the Postgres 17 client tools (`pg_restore`, `psql`), the AWS CLI, the GitHub CLI and a checkout of this repository at the release that made the backup or newer, and access to the backups repository.

1. Pick the backup run: `gh run list -R andidev30/the-artifact-backups --workflow hosted-backup.yml --status success`. Download it:

   ```sh
   gh run download <run-id> -R andidev30/the-artifact-backups --dir backup
   ```

2. Make a new Supabase project in the same region (restoring into a fresh project leaves the damaged one for comparison). Turn off its Data API, create a private bucket and S3 access keys, as when the service was set up.

3. Restore the database and unpack the blobs. `restore.sh` takes the newest `database-*` and `bucket-*` file it finds under `backup/`:

   ```sh
   RESTORE_DATABASE_URL='<new project session pooler URL>' \
   BACKUP_AGE_IDENTITY_FILE=artifact-backup.key \
   ee/ops/backup/restore.sh backup content
   ```

   To restore over an existing database instead of an empty one, add `RESTORE_CLEAN=1`: it drops the app's tables before restoring them, and leaves Supabase's schemas and the `public` schema's grants alone.

4. Bring the schema up to date and check it:

   ```sh
   DATABASE_URL='<new project session pooler URL>' pnpm db:migrate
   DATABASE_URL='<new project session pooler URL>' ee/ops/backup/verify.sh content
   ```

5. Put the blobs back in the new bucket:

   ```sh
   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=<region> \
   AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
   aws s3 cp --recursive content/blobs "s3://<bucket>/blobs" --endpoint-url 'https://<project-ref>.supabase.co/storage/v1/s3'
   ```

6. In Vercel → **Settings** → **Environment Variables**, change `DATABASE_URL` (the new project's transaction pooler, port 6543), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, then **Redeploy** the current production deployment so the function picks them up.

7. Check `/readyz`, sign in, open a few pages and the gallery. Sessions and agents' tokens are in the database, so people stay signed in. Content deleted after the backup comes back and is removed again by the next sweep if nothing refers to it.

8. Update the secrets in [Setting the secrets](#setting-the-secrets) to the new project, or the next backup copies the old one.

## Uptime monitoring and status page

[Upptime](https://upptime.js.org) in the public repository [andidev30/the-artifact-status](https://github.com/andidev30/the-artifact-status). It costs nothing and needs no new account:

- Every 5 minutes, GitHub Actions checks `https://the-artifact-pi.vercel.app/readyz` (the app, Postgres and the bucket), `/healthz` (the function alone, to tell a code or platform outage from a database one) and `/` (the static web app). The list is in that repository's `.upptimerc.yml`.
- On a failure it opens an issue in that repository, assigned to the owner, so GitHub notifies them. It closes the issue when the check passes again.
- The status page, with uptime and response times, is https://andidev30.github.io/the-artifact-status/.
- The workflows push with the secret `GH_PAT`: a fine-grained token limited to that repository, with Actions, Contents, Issues and Workflows set to read and write. When it expires, checks stop and the Actions runs fail. Make a new token and run `gh secret set GH_PAT -R andidev30/the-artifact-status`.
- GitHub turns off scheduled workflows in a public repository after 60 days without commits. Upptime commits its results, so this doesn't happen while it runs.

## Who to contact

| For | Where |
| --- | --- |
| Vercel outages | https://www.vercel-status.com |
| Vercel support | https://vercel.com/help (Hobby: community only; Pro: support tickets from the dashboard) |
| Supabase outages | https://status.supabase.com |
| Supabase support | https://supabase.com/dashboard/support/new (from the project, so it carries its reference) |
| Brevo outages and support | https://status.brevo.com, https://help.brevo.com |
| GitHub Actions outages | https://www.githubstatus.com |
| The service and this repository | The owner, @andidev30 |
