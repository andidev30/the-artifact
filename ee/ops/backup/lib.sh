# shellcheck shell=bash
# Shared by the backup scripts; sourced, not run.

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "$name is not set"
  done
}

need_cmd() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null || die "$cmd is not installed"
  done
}

bytes() {
  wc -c <"$1" | tr -d ' '
}

human() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# The identity is a secret, so it only ever touches a private temporary file that is removed on exit
identity_file() {
  if [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]; then
    echo "$BACKUP_AGE_IDENTITY_FILE"
    return
  fi
  need BACKUP_AGE_IDENTITY
  local file
  file=$(mktemp)
  chmod 600 "$file"
  printf '%s\n' "$BACKUP_AGE_IDENTITY" >"$file"
  echo "$file"
}
