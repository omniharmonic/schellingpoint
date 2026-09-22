#!/bin/sh
# Encrypted nightly backup for unconference.events (spec §12: encrypted, retention-capped, keys off the box).
#   backup.sh          run once now
#   backup.sh --loop   run daily at BACKUP_HOUR_UTC (the compose service's entrypoint)
#   backup.sh --check  exit non-zero when the last verified run is older than BACKUP_MAX_AGE_HOURS
# Produces, per run, in /backups/<stamp>/ and (when configured) s3://$BACKUP_S3_BUCKET/nightly/<stamp>/:
#   postgres.sql.gz.age   pg_dump of the AppView database
#   pds-sqlite.tar.gz.age online (.backup) copies of every PDS SQLite database
#   pds-blocks.tar.gz.age the PDS blob store (immutable files)
# A run counts only once every expected artifact exists, locally and remotely, at a plausible size;
# it then stamps /backups/last-ok, which the compose healthcheck reads.
# Restoring needs the age private key, which lives only with the operator (see README).
set -eu
set -o pipefail

MARKER=/backups/last-ok

# Smallest size, in bytes, that each artifact can plausibly have. An age-encrypted stream of an
# empty gzip is a couple of hundred bytes, so these catch an empty, truncated or half-uploaded
# object without being tight enough to trip on a small-but-real gathering.
MIN_POSTGRES=4096
MIN_PDS_SQLITE=1024
MIN_PDS_BLOCKS=256

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
  blocks=no
  if [ -d /pds/blocks ]; then
    tar -C /pds -czf - blocks | age -r "$BACKUP_AGE_RECIPIENT" > "$dir/pds-blocks.tar.gz.age"
    blocks=yes
  fi

  # Coarse pre-flight only: refuse to upload and rotate over something obviously empty. The
  # per-artifact verification below is what actually decides whether this run is restorable.
  size=$(du -sk "$dir" | cut -f1)
  if [ "$size" -lt 4 ]; then
    echo "backup $stamp is implausibly small (${size}KB); refusing to rotate" >&2
    return 1
  fi

  remote=
  incomplete=0
  if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
    aws s3 cp --endpoint-url "$BACKUP_S3_ENDPOINT" --recursive --only-show-errors "$dir" "s3://$BACKUP_S3_BUCKET/nightly/$stamp/"
    echo "backup $stamp uploaded (${size}KB)"
    # Read the bucket back: a `cp` that exited 0 still has to be visible, and at full length.
    remote=$(aws s3 ls --endpoint-url "$BACKUP_S3_ENDPOINT" "s3://$BACKUP_S3_BUCKET/nightly/$stamp/" || true)
    if [ -z "$remote" ]; then
      echo "BACKUP INCOMPLETE: nightly/$stamp/ (uploaded but the bucket lists nothing)" >&2
      incomplete=1
    fi
  else
    echo "backup $stamp kept locally only (${size}KB): BACKUP_S3_* not configured" >&2
  fi

  check_artifact postgres.sql.gz.age "$MIN_POSTGRES"
  check_artifact pds-sqlite.tar.gz.age "$MIN_PDS_SQLITE"
  if [ "$blocks" = yes ]; then
    check_artifact pds-blocks.tar.gz.age "$MIN_PDS_BLOCKS"
  fi

  rm -rf "$work"
  trap - EXIT

  if [ "$incomplete" -ne 0 ]; then
    echo "BACKUP INCOMPLETE: run $stamp cannot be restored from; $MARKER not advanced" >&2
    return 1
  fi

  printf '%s %s\n' "$(date -u +%s)" "$stamp" > "$MARKER"
  echo "backup $stamp verified: every artifact present at full size"

  # Local copies are a convenience; the bucket's lifecycle rule is the retention of record.
  find /backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
}

# check_artifact <name> <min-bytes>: the file must exist locally at >= min bytes, and — when this
# run was uploaded — the bucket must list it at the same length. Sets `incomplete` instead of
# exiting, so one run reports every missing artifact rather than only the first.
check_artifact() {
  name=$1
  min=$2
  path="$dir/$name"

  if [ ! -f "$path" ]; then
    echo "BACKUP INCOMPLETE: $name (missing from $stamp)" >&2
    incomplete=1
    return 0
  fi
  bytes=$(wc -c < "$path" | tr -d ' ')
  if [ "$bytes" -lt "$min" ]; then
    echo "BACKUP INCOMPLETE: $name ($bytes bytes, under the $min-byte floor, in $stamp)" >&2
    incomplete=1
    return 0
  fi

  if [ -n "$remote" ]; then
    uploaded=$(printf '%s\n' "$remote" | awk -v n="$name" '$4 == n { print $3 }' | tail -n 1)
    if [ -z "$uploaded" ]; then
      echo "BACKUP INCOMPLETE: $name (local copy is fine; nightly/$stamp/$name is not in the bucket)" >&2
      incomplete=1
    elif [ "$uploaded" -ne "$bytes" ]; then
      echo "BACKUP INCOMPLETE: $name (uploaded $uploaded bytes of $bytes to nightly/$stamp/)" >&2
      incomplete=1
    fi
  fi
  return 0
}

# The compose healthcheck: green only while a verified run is recent enough.
check_marker() {
  max_hours=${BACKUP_MAX_AGE_HOURS:-30}
  if [ ! -f "$MARKER" ]; then
    echo "no verified backup yet ($MARKER does not exist)" >&2
    return 1
  fi
  last=$(cut -d' ' -f1 < "$MARKER")
  age_s=$(( $(date -u +%s) - ${last:-0} ))
  if [ "$age_s" -ge $(( max_hours * 3600 )) ]; then
    echo "last verified backup is $(( age_s / 3600 ))h old (limit ${max_hours}h)" >&2
    return 1
  fi
  echo "last verified backup is $(( age_s / 3600 ))h old"
}

case "${1:-}" in
  --loop)
    while true; do
      now_h=$(date -u +%H | sed 's/^0//')
      target=${BACKUP_HOUR_UTC:-3}
      if [ "${now_h:-0}" -eq "$target" ]; then
        # A separate shell preserves errexit inside all backup pipelines.
        /usr/local/bin/backup.sh || echo "BACKUP FAILED: nightly run at $(date -u +%Y%m%dT%H%M%SZ) exited non-zero" >&2
        sleep 3700
      else
        sleep 600
      fi
    done
    ;;
  --check) check_marker ;;
  *) run_once ;;
esac
