#!/usr/bin/env bash
# Start a local Supabase stack in CI, surviving the two ways it fails for
# reasons unrelated to the change under test.
#
#   1. `toomanyrequests` pulling from ghcr.io. Anonymous pulls are rate limited
#      per runner IP and shared with every other job on it. The workflow logs in
#      with GITHUB_TOKEN so pulls are authenticated, which raises the ceiling;
#      this retry covers the rest.
#
#   2. `failed to bind host port for 0.0.0.0:54322 … address already in use`.
#      A previous attempt — or a half-started stack the CLI rolled back — can
#      still hold the port. Retrying without clearing it fails identically, so
#      each attempt stops the stack first.
#
# Usage: ci-supabase-start.sh <project-dir> [attempts]
#
# CI_RETRY_BASE_DELAY overrides the backoff, so the retry logic can be tested
# without waiting on it.
set -uo pipefail

DIR=${1:?project directory required}
ATTEMPTS=${2:-3}
BASE_DELAY=${CI_RETRY_BASE_DELAY:-15}

cd "$DIR" || exit 1

# Leave nothing of a previous run holding a port. `|| true` throughout: there is
# usually nothing to stop, and that is not a failure.
teardown() {
  supabase stop --no-backup >/dev/null 2>&1 || true
}

diagnose() {
  echo "── diagnostics ─────────────────────────────────────────"
  echo "containers:"
  docker ps --format '  {{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null || true
  echo "listeners on the Supabase range:"
  (ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | grep -E ':5[45][0-9]{3}' || echo "  none"
  echo "────────────────────────────────────────────────────────"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "▶ supabase start in $DIR (attempt $attempt of $ATTEMPTS)"

  if supabase start --exclude imgproxy; then
    echo "✓ started"
    exit 0
  fi

  echo "✗ attempt $attempt failed"
  diagnose
  teardown

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    # Linear backoff. The failures being retried are a rate limit and a port
    # still closing, and both clear in seconds rather than minutes.
    delay=$((attempt * BASE_DELAY))
    echo "  retrying in ${delay}s"
    sleep "$delay"
  fi
done

echo "::error::supabase start failed $ATTEMPTS times in $DIR"
diagnose
exit 1
