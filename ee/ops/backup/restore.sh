#!/usr/bin/env bash
# Decrypts the newest backup in <backup-dir>, restores the database into RESTORE_DATABASE_URL and, when
# <content-dir> is given, unpacks the blobs into <content-dir>/blobs.
#   RESTORE_DATABASE_URL=… BACKUP_AGE_IDENTITY='AGE-SECRET-KEY-…' ee/ops/backup/restore.sh <backup-dir> [content-dir]
# BACKUP_AGE_IDENTITY_FILE=<path> works instead of BACKUP_AGE_IDENTITY. RESTORE_CLEAN=1 drops the
# app's existing tables first; without it the database must be empty.
set -euo pipefail
# shellcheck source=ee/ops/backup/lib.sh
. "$(dirname "$0")/lib.sh"

dir=${1:?usage: restore.sh <backup-dir> [content-dir]}
content=${2:-}
need RESTORE_DATABASE_URL
need_cmd pg_restore psql age tar

dump=$(find "$dir" -name 'database-*.dump.age' | sort | tail -n 1)
[ -n "$dump" ] || die "no database-*.dump.age in $dir"

work=$(mktemp -d)
identity=$(identity_file)
cleanup() {
  rm -rf "$work"
  [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] || rm -f "$identity"
}
trap cleanup EXIT

echo "Restoring $(basename "$dump")"
age --decrypt --identity "$identity" --output "$work/db.dump" "$dump"

# The dump has the app's schemas only, not the pg_trgm extension its title index uses. Supabase keeps
# extensions in their own schema, so create it wherever the dump expects it.
trgm_schema=$(pg_restore --schema-only --file - "$work/db.dump" | grep -o '[a-z_]*\.gin_trgm_ops' | head -n 1 | cut -d . -f 1 || true)
trgm_schema=${trgm_schema:-public}
PGOPTIONS='-c client_min_messages=warning' psql "$RESTORE_DATABASE_URL" --quiet --set ON_ERROR_STOP=1 \
  -c "create schema if not exists \"$trgm_schema\"" \
  -c "create extension if not exists pg_trgm schema \"$trgm_schema\""

# Every database already has a public schema, and on Supabase it carries grants that must stay, so the
# dump's own entry for it is skipped (with --clean it would otherwise be dropped)
pg_restore --list "$work/db.dump" | grep -Ev ' SCHEMA - public | COMMENT - SCHEMA public ' >"$work/toc.list"

clean=()
[ "${RESTORE_CLEAN:-}" = 1 ] && clean=(--clean --if-exists)
pg_restore --no-owner --no-privileges --exit-on-error ${clean[@]+"${clean[@]}"} --use-list "$work/toc.list" --dbname "$RESTORE_DATABASE_URL" "$work/db.dump"
echo "Database restored"

if [ -n "$content" ]; then
  bucket=$(find "$dir" -name 'bucket-*.tar.gz.age' | sort | tail -n 1)
  [ -n "$bucket" ] || die "no bucket-*.tar.gz.age in $dir"
  echo "Unpacking $(basename "$bucket")"
  mkdir -p "$content"
  age --decrypt --identity "$identity" "$bucket" | tar -C "$content" -xzf -
  echo "Blobs unpacked into $content/blobs"
fi
