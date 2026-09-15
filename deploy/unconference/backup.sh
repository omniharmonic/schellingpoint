#!/bin/sh
# Encrypted nightly backup for unconference.events (spec §12: encrypted, retention-capped, keys off the box).
#   backup.sh          run once now
#   backup.sh --loop   run daily at BACKUP_HOUR_UTC (the compose service's entrypoint)
# Produces, per run, in /backups/<stamp>/ and (when configured) s3://$BACKUP_S3_BUCKET/nightly/<stamp>/:
#   postgres.sql.gz.age   pg_dump of the AppView database
#   pds-sqlite.tar.gz.age online (.backup) copies of every PDS SQLite database
#   pds-blocks.tar.gz.age the PDS blob store (immutable files)
# Restoring needs the age private key, which lives only with the operator (see README).
set -eu

run_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  dir="/backups/$stamp"
  work=$(mktemp -d)
  mkdir -p "$dir"
  trap 'rm -rf "$work"' EXIT

  pg_dump --no-owner --format=plain | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" > "$dir/postgres.sql.gz.age"

  # SQLite's online backup API gives a consistent copy while the PDS keeps writing.
  mkdir -p "$work/pds"
  (cd /pds && find . -name '*.sqlite' -type f) | while read -r f; do
    mkdir -p "$work/pds/$(dirname "$f")"
    sqlite3 "/pds/$f" ".backup '$work/pds/$f'"
  done
  tar -C "$work/pds" -czf - . | age -r "$BACKUP_AGE_RECIPIENT" > "$dir/pds-sqlite.tar.gz.age"
  if [ -d /pds/blocks ]; then
    tar -C /pds -czf - blocks | age -r "$BACKUP_AGE_RECIPIENT" > "$dir/pds-blocks.tar.gz.age"
  fi

  size=$(du -sk "$dir" | cut -f1)
  if [ "$size" -lt 4 ]; then
    echo "backup $stamp is implausibly small (${size}KB); refusing to rotate" >&2
    return 1
  fi

  if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    aws s3 cp --endpoint-url "$BACKUP_S3_ENDPOINT" --recursive --only-show-errors "$dir" "s3://$BACKUP_S3_BUCKET/nightly/$stamp/"
    echo "backup $stamp uploaded (${size}KB)"
  else
    echo "backup $stamp kept locally only (${size}KB): BACKUP_S3_* not configured" >&2
  fi

  # Local copies are a convenience; the bucket's lifecycle rule is the retention of record.
  find /backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
}

if [ "${1:-}" = "--loop" ]; then
  while true; do
    now_h=$(date -u +%H | sed 's/^0//')
    target=${BACKUP_HOUR_UTC:-3}
    if [ "${now_h:-0}" -eq "$target" ]; then
      run_once || echo "backup failed" >&2
      sleep 3700
    else
      sleep 600
    fi
  done
else
  run_once
fi
