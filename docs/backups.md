# Backup and restore

A self-hosted install keeps its data in two places, and a backup needs both:

| Where | What |
| --- | --- |
| Postgres | Accounts, organizations, members and invitations, sharing, the list of pages and versions, connected agents, admin settings |
| Object storage (the bundled MinIO, or your bucket) | The content: every version's HTML, its files and its thumbnail, one object per distinct content under `blobs/<sha256>` |

Also keep a copy of `app.env` and the `.env` next to the compose file. They hold your mail settings and passwords, and they aren't in either backup.

The commands below are for `deploy/docker-compose/docker-compose.yml` with its bundled MinIO. Run them from `deploy/docker-compose`. They work while the app is running.

## Back up

```sh
mkdir -p backups

# 1. The database
docker compose exec -T db \
  pg_dump -U artifact -Fc artifact > backups/artifact-$(date +%F).dump

# 2. The content, into backups/content
docker compose run --rm --no-deps -v "$PWD/backups:/backups" --entrypoint sh minio -c \
  'mc alias set src http://minio:9000 artifact "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite src/artifact /backups/content'
```

Always dump the database first, then copy the content. Content objects never change once written, so a copy made after the dump has everything the dump refers to.

Copying the content is incremental: `mc mirror` only copies objects that aren't in `backups/content` yet, and it never deletes any. So one content folder serves every database dump you keep: each dump finds its content there, including content that was removed from the server later.

Put `backups/` somewhere off the server, e.g. with `rsync` or `rclone`, on a schedule such as a daily cron job.

## Restore

On a new server (or after wiping the old one), set up the code and configuration as in [Self-hosting](/docs/self-hosting), including `app.env` and `.env` from your backup, and put the `backups/` folder next to the compose file. Then:

```sh
# 1. Start only the database and MinIO
docker compose up -d --wait db minio

# 2. The database (replace the file name with the dump you want)
docker compose exec -T db \
  pg_restore -U artifact -d artifact --clean --if-exists --no-owner < backups/artifact-2026-09-26.dump

# 3. The content
docker compose run --rm --no-deps -v "$PWD/backups:/backups" --entrypoint sh minio -c \
  'mc alias set dst http://minio:9000 artifact "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb -p dst/artifact && mc mirror --overwrite /backups/content dst/artifact'

# 4. Start the app
docker compose up -d
```

If the dump comes from an older version, the app brings the database up to date when it starts. Open a page or two to check, and look at the gallery.

People stay signed in and connected agents keep working after a restore, because sessions and tokens are in the database. If you restored onto a new address, change `APP_URL`. Agents then need the new MCP URL, and people have to sign in again.

## With S3, R2 or your own MinIO

Back up the database the same way. For the content:

- **Bucket versioning or replication.** Turn on versioning or cross-region replication in your storage provider. This protects against deleted and overwritten objects without a separate copy.
- **A copy you control.** Use any S3 tool against the bucket, e.g. `rclone copy remote:artifact backups/content` or `aws s3 sync s3://artifact backups/content`. Use a copy that adds files, not a sync that deletes them, for the reason above.

To restore, copy the content back into the bucket the install uses, with the same object names (`blobs/…`), before starting the app.

## Clean-up after restoring an old backup

A restored database may refer to less content than the bucket holds. The app removes content nothing refers to every few hours. That content is still in `backups/content`, so it is safe to let this happen. To run it now:

```sh
docker compose exec app node dist/scripts/sweep-storage.js
```
