#!/usr/bin/env bash
set -euo pipefail

# SupaForge integration test runner
# Works with both Docker and Podman.
#
# Usage:
#   ./scripts/test-integration.sh          # run integration tests
#   ./scripts/test-integration.sh --no-teardown  # leave containers running after tests

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$CLI_DIR/tests/docker-compose.test.yml"
SEED_SOURCE="$CLI_DIR/tests/fixtures/seed-source.sql"
SEED_TARGET="$CLI_DIR/tests/fixtures/seed-target.sql"

NO_TEARDOWN=false
for arg in "$@"; do
  case "$arg" in
    --no-teardown) NO_TEARDOWN=true ;;
  esac
done

# Detect container runtime
detect_compose() {
  if [[ -n "${COMPOSE_CMD:-}" ]]; then
    echo "$COMPOSE_CMD"
    return
  fi

  # Prefer 'docker compose' (v2 plugin), then docker-compose (standalone), then podman-compose
  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose &>/dev/null; then
    echo "docker-compose"
  elif command -v podman-compose &>/dev/null; then
    echo "podman-compose"
  else
    echo ""
  fi
}

COMPOSE_CMD=$(detect_compose)
if [[ -z "$COMPOSE_CMD" ]]; then
  echo "❌ No container runtime found. Install Docker or Podman with compose support."
  exit 1
fi

echo "🐳 Using compose command: $COMPOSE_CMD"

compose() {
  $COMPOSE_CMD -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  if [[ "$NO_TEARDOWN" == "true" ]]; then
    echo "🔒 --no-teardown: containers left running"
    echo "   Stop with: $COMPOSE_CMD -f $COMPOSE_FILE down -v"
    return 0
  fi

  echo "🧹 Tearing down containers..."
  compose down -v --remove-orphans 2>/dev/null || true
}

trap cleanup EXIT

# Start containers
echo "🚀 Starting Supabase Postgres containers..."
compose up -d --wait

SOURCE_URL="postgresql://postgres:source-test-pass@localhost:15432/postgres"
TARGET_URL="postgresql://postgres:target-test-pass@localhost:15433/postgres"

# Wait for ready (healthcheck should handle this via --wait, but belt-and-suspenders)
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

wait_for_pg "$SOURCE_URL" "source-db"
wait_for_pg "$TARGET_URL" "target-db"

# Seed databases
echo "🌱 Seeding source database..."
psql "$SOURCE_URL" -f "$SEED_SOURCE"

echo "🌱 Seeding target database..."
psql "$TARGET_URL" -f "$SEED_TARGET"

# Export connection URLs for tests
export SUPAFORGE_TEST_SOURCE_URL="$SOURCE_URL"
export SUPAFORGE_TEST_TARGET_URL="$TARGET_URL"

# Run integration tests
echo ""
echo "🧪 Running integration tests..."
cd "$CLI_DIR"
npx vitest run --config vitest.integration.config.ts

echo ""
echo "✅ Integration tests passed!"
