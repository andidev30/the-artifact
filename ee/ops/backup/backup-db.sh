#!/usr/bin/env bash
# Dumps the app's schemas and encrypts the dump for BACKUP_AGE_RECIPIENT before it is written.
#   DATABASE_URL=… BACKUP_AGE_RECIPIENT=age1… ee/ops/backup/backup-db.sh <out-dir>
set -euo pipefail
# shellcheck source=ee/ops/backup/lib.sh
. "$(dirname "$0")/lib.sh"

out=${1:?usage: backup-db.sh <out-dir>}
need DATABASE_URL BACKUP_AGE_RECIPIENT
need_cmd pg_dump age
mkdir -p "$out"
file="$out/database-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

# Only the app's tables (public) and Drizzle's migration log (drizzle). Supabase's own schemas (auth,
# storage, realtime…) and its roles don't exist in a plain Postgres, so a full dump wouldn't restore
# anywhere but Supabase. Owners and grants are left out for the same reason.
pg_dump --format=custom --schema=public --schema=drizzle --no-owner --no-privileges "$DATABASE_URL" |
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$file"

echo "Wrote $file ($(human "$(bytes "$file")"))"
