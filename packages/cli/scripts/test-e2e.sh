#!/usr/bin/env bash
set -euo pipefail

# SupaForge E2E test runner — two real Supabase local instances.
#
# Requires: Supabase CLI (npx supabase), Docker (or Podman with docker compat), psql, curl.
#
# Usage:
#   ./scripts/test-e2e.sh               # full run
#   ./scripts/test-e2e.sh --no-teardown # leave instances running after tests
#   ./scripts/test-e2e.sh --skip-start  # reuse already-running instances

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_PROJECT="$CLI_DIR/tests/e2e/supabase-source"
TARGET_PROJECT="$CLI_DIR/tests/e2e/supabase-target"
SEED_SOURCE="$CLI_DIR/tests/e2e/fixtures/seed-source.sql"
SEED_TARGET="$CLI_DIR/tests/e2e/fixtures/seed-target.sql"

# Services to exclude from Supabase start (studio, imgproxy etc. not needed for testing)
EXCLUDE="imgproxy"

# ─── Podman socket compat ────────────────────────────────────────────────────
# If Docker is not available but Podman is, export DOCKER_HOST so the Supabase
# CLI can find containers via the Podman socket (requires podman system service).
if ! command -v docker &>/dev/null && command -v podman &>/dev/null; then
  PODMAN_SOCK="unix:///run/user/$(id -u)/podman/podman.sock"
  if [[ -S "/run/user/$(id -u)/podman/podman.sock" ]]; then
    export DOCKER_HOST="$PODMAN_SOCK"
    echo "ℹ️  Using Podman socket: $DOCKER_HOST"
  fi
fi

NO_TEARDOWN=false
SKIP_START=false
for arg in "$@"; do
  case "$arg" in
    --no-teardown) NO_TEARDOWN=true ;;
    --skip-start)  SKIP_START=true ;;
  esac
done

# ─── Dependency checks ───────────────────────────────────────────────────────

check_deps() {
  local missing=()

  if ! npx supabase --version &>/dev/null 2>&1; then
    missing+=("supabase (install: npm i -g supabase)")
  fi

  if ! command -v docker &>/dev/null && ! command -v podman &>/dev/null; then
    missing+=("docker or podman")
  fi

  if ! command -v psql &>/dev/null; then
    missing+=("psql (install: apt install postgresql-client)")
  fi

  if ! command -v curl &>/dev/null; then
    missing+=("curl")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "❌ Missing dependencies:"
    for dep in "${missing[@]}"; do
      echo "   - $dep"
    done
    exit 1
  fi
}

check_deps

# ─── Helpers ──────────────────────────────────────────────────────────────────

# Extract a value from `supabase status -o env` output
parse_status() {
  local dir="$1"
  local key="$2"
  cd "$dir" && npx supabase status -o env 2>/dev/null | grep "^${key}=" | head -1 | sed "s/^${key}=//" | tr -d '"'
}

wait_for_pg() {
  local url="$1"
  local label="$2"
  local retries=30
  while ! psql "$url" -c "SELECT 1" &>/dev/null 2>&1; do
    retries=$((retries - 1))
    if [[ $retries -le 0 ]]; then
      echo "❌ Timed out waiting for $label"
      exit 1
    fi
    sleep 2
  done
  echo "✅ $label is ready"
}

create_bucket() {
  local api_url="$1"
  local service_key="$2"
  local bucket_id="$3"
  local bucket_name="$4"
  local is_public="$5"
  local file_size_limit="${6:-0}"

  local body="{\"id\":\"$bucket_id\",\"name\":\"$bucket_name\",\"public\":$is_public"
  if [[ "$file_size_limit" != "0" ]]; then
    body+=",\"file_size_limit\":$file_size_limit"
  fi
  body+="}"

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${api_url}/storage/v1/bucket" \
    -H "Authorization: Bearer ${service_key}" \
    -H "apikey: ${service_key}" \
    -H "Content-Type: application/json" \
    -d "$body")

  if [[ "$status" == "200" || "$status" == "201" ]]; then
    echo "   ✅ Bucket '$bucket_name' created"
  else
    echo "   ⚠️  Bucket '$bucket_name' returned HTTP $status (may already exist)"
  fi
}

# Empty and delete a storage bucket — idempotent, ignores "not found" errors.
delete_bucket() {
  local api_url="$1"
  local service_key="$2"
  local bucket_id="$3"

  # Empty all objects first (Storage API requires bucket to be empty before delete)
  curl -s -o /dev/null \
    -X DELETE "${api_url}/storage/v1/object/${bucket_id}/" \
    -H "Authorization: Bearer ${service_key}" \
    -H "apikey: ${service_key}" \
    -H "Content-Type: application/json" || true

  # Delete the bucket itself (ignore errors — bucket may not exist)
  curl -s -o /dev/null \
    -X DELETE "${api_url}/storage/v1/bucket/${bucket_id}" \
    -H "Authorization: Bearer ${service_key}" \
    -H "apikey: ${service_key}" || true
}

# ─── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  if [[ "$NO_TEARDOWN" == "true" ]]; then
    echo ""
    echo "🔒 --no-teardown: instances left running"
    echo "   Stop with:"
    echo "     cd $SOURCE_PROJECT && npx supabase stop --no-backup"
    echo "     cd $TARGET_PROJECT && npx supabase stop --no-backup"
    return 0
  fi

  echo ""
  echo "🧹 Tearing down Supabase instances..."
  (cd "$SOURCE_PROJECT" && npx supabase stop --no-backup 2>/dev/null) || true
  (cd "$TARGET_PROJECT" && npx supabase stop --no-backup 2>/dev/null) || true
}

trap cleanup EXIT

# ─── Start Supabase instances ────────────────────────────────────────────────

if [[ "$SKIP_START" == "false" ]]; then
  echo "🚀 Starting source Supabase instance (port 54321/54322)..."
  (cd "$SOURCE_PROJECT" && npx supabase start --exclude "$EXCLUDE")

  echo ""
  echo "🚀 Starting target Supabase instance (port 55321/55322)..."
  (cd "$TARGET_PROJECT" && npx supabase start --exclude "$EXCLUDE")
else
  echo "⏭️  --skip-start: reusing running instances"
fi

# ─── Gather connection details ───────────────────────────────────────────────

echo ""
echo "📋 Gathering connection details..."

SOURCE_DB_URL=$(parse_status "$SOURCE_PROJECT" "DB_URL")
SOURCE_API_URL=$(parse_status "$SOURCE_PROJECT" "API_URL")
SOURCE_SERVICE_KEY=$(parse_status "$SOURCE_PROJECT" "SERVICE_ROLE_KEY")

TARGET_DB_URL=$(parse_status "$TARGET_PROJECT" "DB_URL")
TARGET_API_URL=$(parse_status "$TARGET_PROJECT" "API_URL")
TARGET_SERVICE_KEY=$(parse_status "$TARGET_PROJECT" "SERVICE_ROLE_KEY")

if [[ -z "$SOURCE_DB_URL" || -z "$TARGET_DB_URL" ]]; then
  echo "❌ Failed to get connection details. Are both instances running?"
  exit 1
fi

echo "   Source DB:  $SOURCE_DB_URL"
echo "   Source API: $SOURCE_API_URL"
echo "   Target DB:  $TARGET_DB_URL"
echo "   Target API: $TARGET_API_URL"

# ─── Wait for databases ─────────────────────────────────────────────────────

wait_for_pg "$SOURCE_DB_URL" "source-db"
wait_for_pg "$TARGET_DB_URL" "target-db"

# ─── Seed databases ─────────────────────────────────────────────────────────

echo ""
echo "🌱 Seeding source database..."
psql "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 -f "$SEED_SOURCE"

echo ""
echo "🌱 Seeding target database..."
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f "$SEED_TARGET"

# ─── Create storage buckets (via API) ───────────────────────────────────────

echo ""
echo "🪣 Resetting storage buckets in source..."
for bucket in avatars documents; do
  delete_bucket "$SOURCE_API_URL" "$SOURCE_SERVICE_KEY" "$bucket"
done
create_bucket "$SOURCE_API_URL" "$SOURCE_SERVICE_KEY" "avatars" "avatars" "true" "10485760"
create_bucket "$SOURCE_API_URL" "$SOURCE_SERVICE_KEY" "documents" "documents" "false"

echo ""
echo "🪣 Resetting storage buckets in target (drifted)..."
for bucket in avatars documents backups; do
  delete_bucket "$TARGET_API_URL" "$TARGET_SERVICE_KEY" "$bucket"
done
# DRIFT: avatars is private (source is public)
create_bucket "$TARGET_API_URL" "$TARGET_SERVICE_KEY" "avatars" "avatars" "false" "10485760"
# DRIFT: documents is MISSING (not created)
# DRIFT: backups is EXTRA (not in source)
create_bucket "$TARGET_API_URL" "$TARGET_SERVICE_KEY" "backups" "backups" "false"

# ─── Run E2E tests ──────────────────────────────────────────────────────────

echo ""
echo "🧪 Running E2E tests..."

export SUPAFORGE_E2E_SOURCE_DB_URL="$SOURCE_DB_URL"
export SUPAFORGE_E2E_TARGET_DB_URL="$TARGET_DB_URL"
export SUPAFORGE_E2E_SOURCE_API_URL="$SOURCE_API_URL"
export SUPAFORGE_E2E_TARGET_API_URL="$TARGET_API_URL"
export SUPAFORGE_E2E_SOURCE_SERVICE_KEY="$SOURCE_SERVICE_KEY"
export SUPAFORGE_E2E_TARGET_SERVICE_KEY="$TARGET_SERVICE_KEY"

cd "$CLI_DIR"
npx vitest run --config vitest.e2e.config.ts

echo ""
echo "✅ E2E tests passed!"
