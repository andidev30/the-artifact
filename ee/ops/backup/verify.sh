#!/usr/bin/env bash
# Checks a restored database (and its unpacked blobs) and prints a Markdown report. Exits non-zero
# when a check fails. Run it after the app's migrations, so it also shows they apply to real data.
#   DATABASE_URL=… ee/ops/backup/verify.sh [content-dir]
set -euo pipefail
# shellcheck source=ee/ops/backup/lib.sh
. "$(dirname "$0")/lib.sh"

content=${1:-}
need DATABASE_URL
need_cmd psql
journal="$(dirname "$0")/../../../apps/api/drizzle/meta/_journal.json"
failed=0

q() {
  psql "$DATABASE_URL" --no-align --tuples-only --set ON_ERROR_STOP=1 -c "$1"
}

expected=$(grep -c '"tag"' "$journal")
applied=$(q 'select count(*) from drizzle.__drizzle_migrations')
echo '| Check | Result |'
echo '| --- | --- |'
if [ "$applied" = "$expected" ]; then
  echo "| Migrations | $applied of $expected applied |"
else
  echo "| Migrations | **$applied of $expected applied** |"
  failed=1
fi

for table in users organizations memberships artifacts artifact_versions artifact_files artifact_comments oauth_tokens access_tokens; do
  echo "| Rows in \`$table\` | $(q "select count(*) from $table") |"
done

if [ -n "$content" ]; then
  q "select html_sha256 from artifact_versions union select sha256 from artifact_files union select sha256 from artifact_thumbnails where sha256 is not null" |
    sort -u >"$content/referenced.txt"
  (cd "$content/blobs" 2>/dev/null && find . -type f | sed 's|^\./||' | sort -u) >"$content/present.txt" || true
  missing=$(comm -23 "$content/referenced.txt" "$content/present.txt" | wc -l | tr -d ' ')
  total=$(wc -l <"$content/referenced.txt" | tr -d ' ')
  if [ "$missing" = 0 ]; then
    echo "| Blobs | all $total referenced blobs present ($(wc -l <"$content/present.txt" | tr -d ' ') in the copy) |"
  else
    echo "| Blobs | **$missing of $total referenced blobs missing** |"
    comm -23 "$content/referenced.txt" "$content/present.txt" | head -n 5 | sed 's/^/missing: /' >&2
    failed=1
  fi
fi

exit "$failed"
