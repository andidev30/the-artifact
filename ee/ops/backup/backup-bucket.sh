#!/usr/bin/env bash
# Copies every blob in the bucket and writes them as one encrypted, compressed tar.
#   S3_ENDPOINT=… S3_REGION=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
#   BACKUP_AGE_RECIPIENT=age1… ee/ops/backup/backup-bucket.sh <out-dir>
set -euo pipefail
# shellcheck source=ee/ops/backup/lib.sh
. "$(dirname "$0")/lib.sh"

out=${1:?usage: backup-bucket.sh <out-dir>}
need S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT
need_cmd aws age tar
mkdir -p "$out"
file="$out/bucket-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=$S3_REGION
# Newer AWS CLIs add checksums that S3-compatible stores (Supabase, MinIO, R2) don't all accept
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# Only blobs/: rows refer to nothing else. uploads/ holds direct uploads that expire within minutes.
mkdir -p "$work/blobs"
aws s3 sync "s3://$S3_BUCKET/blobs" "$work/blobs" --endpoint-url "$S3_ENDPOINT" --only-show-errors
count=$(find "$work/blobs" -type f | wc -l | tr -d ' ')

# Compressed before encrypting, since encrypted bytes don't compress
tar -C "$work" -czf - blobs | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$file"

echo "Wrote $file ($count blobs, $(human "$(bytes "$file")"))"
