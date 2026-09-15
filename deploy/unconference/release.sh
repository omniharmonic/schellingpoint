#!/usr/bin/env bash
# Release unconference.events from the checked-out branch: back up, build, migrate, deploy, verify.
# Run on the server from anywhere:  /opt/unconference/deploy/unconference/release.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
C=(docker compose --env-file deploy/unconference/.env -f deploy/unconference/compose.yml -p unconference)

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked changes present; commit or stash them before releasing." >&2
  exit 1
fi
BEFORE=$(git rev-parse --short HEAD)
git pull --ff-only
AFTER=$(git rev-parse --short HEAD)
echo "== release $BEFORE -> $AFTER"
"${C[@]}" config --quiet

# A backup before every release that touches a running stack.
if [ -n "$("${C[@]}" ps -q postgres 2>/dev/null)" ]; then
  echo "== pre-release backup"
  "${C[@]}" run --rm --no-deps --entrypoint /usr/local/bin/backup.sh backup
  image=$(docker inspect --format '{{.Image}}' "$("${C[@]}" ps -q app)" 2>/dev/null || true)
  [ -n "$image" ] && docker tag "$image" "unconference-app:rollback-$BEFORE"
fi

export RELEASE="$AFTER"
"${C[@]}" build migrate backup
"${C[@]}" up -d postgres pds
"${C[@]}" run --rm migrate
"${C[@]}" up -d --remove-orphans
docker tag "unconference-app:$AFTER" unconference-app:current

HOST=$(sed -n 's/^WEB_HOST=//p' deploy/unconference/.env)
echo "== waiting for health"
for attempt in $(seq 1 40); do
  if curl -fsS -m 10 "https://$HOST/api/health" | grep -q '"status":"ok"'; then
    echo "== healthy; running the privacy audit"
    "${C[@]}" exec -T app npm run -s atproto:audit
    echo "== released $AFTER"
    exit 0
  fi
  sleep 5
done
echo "Health check failed; the previous image is tagged unconference-app:rollback-$BEFORE" >&2
exit 1
