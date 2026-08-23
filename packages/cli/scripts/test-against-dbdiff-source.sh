#!/usr/bin/env bash
set -euo pipefail

# Run SupaForge against a local @dbdiff/cli SOURCE checkout instead of the
# released build, so a fix in DBDiff can be validated through SupaForge before
# anyone cuts a release.
#
# Why this is possible: the @dbdiff/cli npm package prefers a pre-built native
# binary but falls back to the bundled dbdiff.phar run with system PHP. Moving
# the binary aside and replacing the phar with a one-line shim into a source
# checkout makes the whole stack run patched code. Nothing is published, nothing
# is linked, and node_modules is restored on exit.
#
# PHP is not required on the host: SupaForge, PHP and psql all run inside a
# throwaway container image built here. Only a container runtime is needed.
#
# Usage:
#   ./scripts/test-against-dbdiff-source.sh [--dbdiff PATH] [--keep] [--sql DIR]
#
#   --dbdiff PATH   DBDiff checkout (default: ../../../DBDiff, then ../DBDiff)
#   --sql DIR       Directory of .sql files to load into the source database
#                   (default: the built-in stage ladder from tests/harness)
#   --keep          Leave containers running for inspection
#
# Exit status is 0 only when the target ends up structurally identical to the
# source, so this is safe to call from CI.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DBDIFF_SRC=""
FIXTURE_DIR=""
KEEP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dbdiff) DBDIFF_SRC="$2"; shift 2 ;;
    --sql)    FIXTURE_DIR="$2"; shift 2 ;;
    --keep)   KEEP=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── locate the DBDiff checkout ───────────────────────────────────────────────
if [ -z "$DBDIFF_SRC" ]; then
  for candidate in "$CLI_DIR/../../../DBDiff" "$CLI_DIR/../../DBDiff" "$CLI_DIR/../DBDiff"; do
    [ -f "$candidate/dbdiff.php" ] && { DBDIFF_SRC="$(cd "$candidate" && pwd)"; break; }
  done
fi
if [ ! -f "${DBDIFF_SRC:-}/dbdiff.php" ]; then
  echo "DBDiff source not found. Pass --dbdiff /path/to/DBDiff" >&2
  exit 1
fi
if [ ! -d "$DBDIFF_SRC/vendor" ]; then
  echo "DBDiff has no vendor/ — run 'composer install' in $DBDIFF_SRC first" >&2
  exit 1
fi

# ── container runtime (podman preferred: lighter) ────────────────────────────
RT=""
for c in podman docker; do command -v "$c" >/dev/null 2>&1 && { RT="$c"; break; }; done
[ -z "$RT" ] && { echo "Neither podman nor docker is available" >&2; exit 1; }

# Podman's bridge networking needs netavark, which is broken on some hosts;
# host networking sidesteps it and is fine for throwaway test databases.
NET="--network=host"
RUN_ID="sfdd-$$"
SRC_C="${RUN_ID}-source"
TGT_C="${RUN_ID}-target"
IMAGE="supaforge-dbdiff-src"
PGPASS="supaforge-test"

# Ephemeral ports: fixed ones collide when suites run in parallel.
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'; }
SRC_PORT="$(free_port)"
TGT_PORT="$(free_port)"

NM="$CLI_DIR/node_modules/@dbdiff/cli"
NATIVE_DIR="$CLI_DIR/node_modules/@dbdiff/cli-linux-x64"
RESTORED=false

# Every step here is guarded: this runs from an EXIT trap under `set -e`, so a
# single non-zero test would abort the rest of the cleanup and strand both the
# containers and a patched node_modules.
restore() {
  [ "$RESTORED" = true ] && return 0
  RESTORED=true
  if [ -f "$NATIVE_DIR/dbdiff.disabled" ]; then
    mv -f "$NATIVE_DIR/dbdiff.disabled" "$NATIVE_DIR/dbdiff" || true
  fi
  if [ -f "/tmp/$RUN_ID.phar" ]; then
    mv -f "/tmp/$RUN_ID.phar" "$NM/dbdiff.phar" || true
  fi
  return 0
}

cleanup() {
  local code=$?
  set +e
  restore
  if [ "$KEEP" = true ]; then
    echo "--keep: leaving $SRC_C (:$SRC_PORT) and $TGT_C (:$TGT_PORT) running"
  else
    $RT rm -f "$SRC_C" "$TGT_C" >/dev/null 2>&1 || true
  fi
  exit $code
}
trap cleanup EXIT INT TERM

# ── build the runner image (node + php + pdo_pgsql + psql) ───────────────────
if ! $RT image exists "$IMAGE" >/dev/null 2>&1 && ! $RT image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (one-off)…"
  $RT build $NET -t "$IMAGE" -f - "$CLI_DIR" >/dev/null <<'DOCKERFILE'
FROM docker.io/library/php:8.3-cli
RUN apt-get update -qq \
 && apt-get install -y -qq libpq-dev postgresql-client curl >/dev/null \
 && docker-php-ext-install -j"$(nproc)" pdo_pgsql >/dev/null \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
 && apt-get install -y -qq nodejs >/dev/null \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

# ── start the database pair ──────────────────────────────────────────────────
start_pg() {
  $RT run -d --name "$1" $NET \
    -e POSTGRES_PASSWORD="$PGPASS" -e PGPORT="$2" \
    docker.io/library/postgres:16-alpine >/dev/null
}
echo "starting databases (source :$SRC_PORT, target :$TGT_PORT) via $RT…"
start_pg "$SRC_C" "$SRC_PORT"
start_pg "$TGT_C" "$TGT_PORT"

for _ in $(seq 1 60); do
  $RT exec "$SRC_C" pg_isready -p "$SRC_PORT" >/dev/null 2>&1 \
    && $RT exec "$TGT_C" pg_isready -p "$TGT_PORT" >/dev/null 2>&1 && break
  sleep 1
done

psql_src() { $RT exec -i "$SRC_C" psql -U postgres -p "$SRC_PORT" -d postgres "$@"; }
psql_tgt() { $RT exec -i "$TGT_C" psql -U postgres -p "$TGT_PORT" -d postgres "$@"; }

# ── load the fixture into the source ─────────────────────────────────────────
# Roles that Supabase-flavoured SQL commonly GRANTs to; harmless otherwise.
psql_src -q -c "CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;" >/dev/null 2>&1 || true

if [ -n "$FIXTURE_DIR" ]; then
  echo "loading fixtures from $FIXTURE_DIR…"
  for f in "$FIXTURE_DIR"/*.sql; do
    [ -e "$f" ] || continue
    psql_src -q -f - < "$f" >/dev/null 2>&1 || echo "  (skipped $(basename "$f"))"
  done
else
  echo "loading the built-in stage ladder…"
  # stages.ts is TypeScript, so it needs tsx — plain node cannot resolve it.
  TSX="$CLI_DIR/node_modules/.bin/tsx"
  [ -x "$TSX" ] || { echo "tsx not found — run 'npm ci' in $CLI_DIR" >&2; exit 1; }
  STAGE_ENTRY="$(mktemp --suffix=.ts)"
  cat > "$STAGE_ENTRY" <<TS
import { STAGES } from '$CLI_DIR/test/harness/stages.js'
process.stdout.write(STAGES.map((s) => s.sql).join('\n'))
TS
  "$TSX" "$STAGE_ENTRY" | psql_src -q -v ON_ERROR_STOP=1 -f - >/dev/null
  rm -f "$STAGE_ENTRY"
fi

echo "source: $(psql_src -tAc "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')" | tr -d '[:space:]') tables"

# ── point @dbdiff/cli at the source checkout ─────────────────────────────────
echo "wiring @dbdiff/cli to $DBDIFF_SRC…"
[ -f "$NATIVE_DIR/dbdiff" ] && mv -f "$NATIVE_DIR/dbdiff" "$NATIVE_DIR/dbdiff.disabled"
cp -f "$NM/dbdiff.phar" "/tmp/$RUN_ID.phar"
printf '<?php require "/dbdiff/dbdiff.php";\n' > "$NM/dbdiff.phar"

WS="$(mktemp -d)"
cat > "$WS/supaforge.config.json" <<CONFIG
{
  "environments": {
    "source": { "dbUrl": "postgresql://postgres:$PGPASS@127.0.0.1:$SRC_PORT/postgres" },
    "target": { "dbUrl": "postgresql://postgres:$PGPASS@127.0.0.1:$TGT_PORT/postgres" }
  },
  "source": "source",
  "target": "target"
}
CONFIG

# ── run the real CLI against the patched DBDiff ──────────────────────────────
echo
$RT run --rm $NET \
  -v "$CLI_DIR/../..:/sf:z" -v "$DBDIFF_SRC:/dbdiff:z" -v "$WS:/ws:z" -w /ws \
  "$IMAGE" node /sf/packages/cli/bin/run.js sync --check schema --apply --allow-destructive \
  || true

# ── assert the target really matches the source ──────────────────────────────
FP="SELECT string_agg(line, E'\n' ORDER BY line) FROM (
  SELECT format('col %s.%s %s %s %s', table_name, column_name, data_type, is_nullable, coalesce(column_default,'-')) AS line
    FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT format('con %s %s', c.conname, pg_get_constraintdef(c.oid))
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
  UNION ALL SELECT format('idx %s %s', indexname, indexdef)
    FROM pg_indexes WHERE schemaname='public'
  UNION ALL SELECT format('rel %s %s %s', c.relname, c.relkind::text, coalesce(pg_get_expr(c.relpartbound,c.oid),'-'))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
) t"

psql_src -tAc "$FP" > "$WS/source.fp"
psql_tgt -tAc "$FP" > "$WS/target.fp"

echo
echo "── structural comparison ───────────────────────────────────────────────"
echo "source objects: $(wc -l < "$WS/source.fp")   target objects: $(wc -l < "$WS/target.fp")"
if diff -q "$WS/source.fp" "$WS/target.fp" >/dev/null; then
  echo "PASS — target is structurally identical to source"
  exit 0
fi
echo "FAIL — differences:"
diff "$WS/source.fp" "$WS/target.fp" | grep '^[<>]' | head -25
exit 1
