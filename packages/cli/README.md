# supaforge

> Diff and sync your Supabase environments.

Built by [Akal Forge](https://github.com/akalforge).

## Quick Start

```bash
npm install -g @akalforge/supaforge

# Interactive setup — creates supaforge.config.json
supaforge init

# Check for drift
supaforge diff

# See detailed SQL diffs
supaforge diff --detail

# Fix the drift
supaforge diff --apply
```

## Single Database

Working with one Supabase project? Choose "single" mode during `supaforge init` to set up snapshot, clone, and restore workflows without needing a second environment.

```bash
supaforge init                                       # Choose "single" mode
supaforge snapshot --env=prod                        # Capture current state
supaforge clone --env=prod --apply                   # Clone remote to local
supaforge snapshot --env=prod --migration            # Incremental backup with migration
```

## Comprehensive Checks

| Check | Source | Detection | Fix |
|-------|--------|-----------|-----|
| Schema | `@dbdiff/cli` | ✅ Tables, views, triggers, functions, enum types | SQL (up/down) |
| Data | `@dbdiff/cli --type=data` | ✅ Row-level diff for all public tables (configurable). Checksum-based fast skip for unchanged tables. | SQL (up/down) |
| RLS Policies | `pg_policies` view | ✅ | SQL (up/down) |
| Edge Functions | Management API | ✅ **Hosted only** — skipped on self-hosted | DELETE extras via API; missing/outdated → manual `supabase functions deploy` |
| Storage | Storage API + `pg_policies` | ✅ Buckets, policies. `--include-files` adds file-level drift detection (checksums for JSON, size/date for binary). | Buckets via API (POST/PUT/DELETE); Policies via SQL |
| Auth Config | Management API, or GoTrue `/auth/v1/settings` when `apiUrl` is set | ✅ Self-hosted covers provider flags and signup settings, not `JWT_EXP` / `MFA_ENABLED` | PATCH via API (hosted only) |
| Cron Jobs | `cron.job` table | ✅ | SQL (up/down) |
| Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ | SQL when trigger metadata available |
| Realtime Publications | `pg_publication` + `pg_publication_tables` | ✅ | SQL (CREATE/ALTER PUBLICATION) |
| Vault Secrets | `vault.secrets` | ✅ | SQL (`vault.create_secret` / `vault.update_secret`) |
| Postgres Extensions | `pg_extension` | ✅ | SQL (CREATE/DROP EXTENSION) |


### Scoping a diff to specific tables

`--check` / `--skip` select whole layers. `--tables` / `--exclude-tables` scope
*within* the schema and data layers, which is what makes it possible to promote
a reviewed subset between environments rather than applying everything a layer
found:

```bash
supaforge diff --tables=orders,order_items          # only these two
supaforge diff --tables='billing_*' --exclude-tables='*_audit'
supaforge diff --tables=orders --apply              # promote just this table
```

Both flags are repeatable and comma-separated, and take the same `*` / `?`
globs `@dbdiff/cli` supports. The scope is enforced inside the diff itself —
dbdiff is told what to compare — rather than by generating everything and
discarding findings afterwards.

The equivalent config keys make a scope repeatable:

```json
{
  "checks": {
    "tables": ["orders", "order_items"],
    "excludeTables": ["*_audit", "*_log"]
  }
}
```

**Precedence.** `--tables` *overrides* `checks.tables` — asking for one table on
the command line must not be widened by a broader list in config.
`--exclude-tables` is *unioned* with `checks.excludeTables`, the same way
`--skip` merges with `checks.exclude`: an exclusion is a safety rail, so both
sources excluding more is never the surprising direction.

**Which layers it reaches.** A table is a concept the schema and data checks
have and the others do not, so `diff --tables=orders` still compares every RLS
policy, storage bucket and cron job. A scoped run says so before it starts:

```
  Scoped to only orders — applies to the schema and data checks; other layers are unfiltered.
```

**Dependants of an excluded table.** dbdiff's `--tables` covers *tables*, so a
scoped fix set still arrives carrying the views, triggers and indexes hanging
off the tables it excluded. With `--apply`, those are skipped with a reason
naming the table rather than attempted and failed:

```
○ [schema] schema-create-view-2: Depends on table 'orders', excluded by --tables
```

**Scoping to something other than a table.** `--tables` has no way to express
"these two tables and these three functions". `--only` does, by taking the
issue ids `--json` already reports:

```bash
supaforge diff --check=schema --json > plan.json
supaforge diff --apply --only=schema-create-function-7,schema-create-trigger-6
supaforge diff --apply --only='schema-create-*'
```

Combine with `--check=schema` when you want the run itself narrowed too.

### Drift score vs posture score

Twelve of the fourteen checks compare source against target. Two do not:

- **RLS Coverage** reads only the target, listing tables with RLS disabled.
- **Migration History** compares local migration *files* against the target's
  tracking table.

Both fire identically whichever pair you diff, so they are scored separately.
Counting them as drift meant a diff of an environment *against itself* could
never reach 100, and any project with a long-standing RLS gap scored 0 no
matter how well synchronised its environments were:

```
SupaForge scan complete: no drift detected. ✓
9 posture findings (RLS coverage / migration history) — present regardless of which pair you diff.

  ✓ Layer 1 (Schema):                   0 issues
  ● Layer 3 (RLS Coverage):             8 issues[CRITICAL]
  ● Layer 13 (Migration History):       1 issue[INFO]

Drift score: 100/100
Posture score: 0/100 (target only — RLS coverage, migration history)
```

The findings are not discarded or downgraded — they keep their severity, appear
in `--detail`, and a critical one **still fails CI**. Only the drift score
changes, so `no drift detected` becomes a trustworthy synchronisation signal.
`--ci` output carries `postureScore` alongside `score`.

### Self-hosted Supabase

Set `apiUrl` on an environment and every API-backed check targets that gateway
instead of `api.supabase.com`, authenticating with the service-role key in
`accessToken`. `projectRef` is not required when `apiUrl` is set — it is only a
path segment on a hosted URL that will not be called.

```json
{
  "environments": {
    "self-hosted-a": {
      "dbUrl": "$DB_URL_A",
      "apiUrl": "https://supabase.example.com",
      "accessToken": "$SUPABASE_SERVICE_KEY"
    }
  }
}
```

Thirteen of the fourteen checks run against self-hosted. **Edge Functions is
hosted-only**: self-hosted Supabase exposes no equivalent "list functions"
management endpoint, so the check reports

```
  ○ Layer 4 (Edge Functions):           skipped — Edge Functions comparison requires hosted Supabase — self-hosted exposes no management endpoint
```

rather than attempting a call that can only return `Unauthorized`. Add it to
`checks.exclude` if you would rather not see the line at all.

Auth Config reads GoTrue's `/auth/v1/settings` on self-hosted, which exposes
fewer keys than the hosted Management API's `/config/auth` — provider flags and
signup settings, but not `JWT_EXP` or `MFA_ENABLED`. Because the two shapes are
not comparable, a self-hosted source and a hosted target are reported as
skipped rather than diffed against each other. Self-hosted GoTrue also has no
config write endpoint, so its findings carry no `--apply` action: change the
target deployment's environment and restart it.

### Skipped checks

A check that cannot run — no credentials configured, an extension absent, no
tables listed to compare — is reported as **skipped with the reason**, never as
a clean pass:

```
  ✓ Layer 1 (Schema):                   0 issues
  ○ Layer 4 (Edge Functions):           skipped — no projectRef or accessToken configured
  ○ Layer 6 (Auth Config):              skipped — no projectRef or accessToken configured
  ✓ Layer 7 (Cron Jobs):                0 issues
  ○ Layer 8 (Reference Data):           skipped — no tables configured in checks.data.tables

Drift score: 100/100 (2 of 5 checks compared)
```

The closing line says `N checks were skipped — coverage is partial`, and the
score carries the denominator it was computed over, so a perfect number across
a partial run cannot be read as a full comparison.

A skip is not drift and does not reduce the score or fail CI — penalising it
would give every self-hosted project a permanently depressed score for layers
it deliberately cannot run. `--ci` output carries a `skipped` array and a
`coverage` object alongside the existing `errors` array, so a pipeline can gate
on coverage explicitly if it wants to:

```json
{
  "score": 100,
  "coverage": { "compared": 2, "total": 5 },
  "skipped": [
    { "check": "auth", "reason": "no projectRef or accessToken configured" }
  ],
  "errors": []
}
```

## Commands

```
supaforge init                          Create supaforge.config.json interactively
supaforge init --force                  Overwrite existing config file

supaforge diff                          Summary: what's drifted? (score + pass/fail)
supaforge diff --detail                 Show detailed SQL diffs
supaforge diff --apply                  Apply SQL + API fixes to the target environment
supaforge diff --apply --dry-run        Print the fixes in execution order, run nothing
supaforge diff --apply --allow-destructive  Also apply fixes that drop tables/columns
supaforge diff --apply --no-transaction Apply statement by statement, keeping partial progress
supaforge diff --apply --only=<id,...>  Apply only these issue ids (globs allowed)
supaforge diff --check=rls              Limit to a specific check
supaforge diff --check=rls --apply      Fix only one check
supaforge diff --skip=storage           Skip a specific check
supaforge diff --skip=auth --skip=vault Skip multiple checks (flag is repeatable)
supaforge diff --include-files          Include file-level storage drift detection
supaforge diff --json                   Output as JSON
supaforge hukam                         Alias for diff 🙏

supaforge snapshot                      Capture a full environment snapshot (9 layers)
supaforge snapshot --env=prod           Snapshot a specific environment
supaforge snapshot --migration          Capture + generate incremental migration diff
supaforge snapshot --list               List all snapshots
supaforge snapshot --prune              Preview old snapshot cleanup (keeps last 7)
supaforge snapshot --prune --apply      Delete old snapshots
supaforge snapshot --prune --keep=5     Keep last 5 instead of 7

supaforge clone --env=prod              Preflight checks (validates connectivity)
supaforge clone --env=prod --apply      Clone remote to local (snapshot + baseline)
supaforge clone --env=prod --force      Force re-clone (drop existing DB)
supaforge clone --env=prod --start-local  Auto-start a local PostgreSQL container
supaforge clone --schema-only --apply   Clone schema only, no data
supaforge clone --list                  List existing clones
supaforge clone --delete=<name>         Preview clone deletion
supaforge clone --delete=<name> --apply Drop database and remove tracking

supaforge restore --env=local --from-snapshot=latest          Preview snapshot restore
supaforge restore --env=local --from-snapshot=latest --apply  Apply snapshot to target
supaforge restore --env=local --from-migrations --apply       Replay migration history
```

### Safe by Default

Commands that modify databases preview what they would do first. Add `--apply` to execute:

```bash
# Preview only (default)
supaforge diff
supaforge clone --env=prod

# Actually execute
supaforge diff --apply
supaforge clone --env=prod --apply
```

**Destructive fixes need a second opt-in.** Drift that would destroy rows —
dropping a table, or dropping a column — is always *reported*, but `--apply`
skips it unless you also pass `--allow-destructive`:

```
$ supaforge diff --apply

Applied 1 fix(es):
  ✓ [schema] schema-alter-1

Skipped 1 issue(s):
  ○ [schema] schema-drop-1: Destructive (drops data) — re-run with --allow-destructive to apply
```

```bash
# Also drop the extra table/column
supaforge diff --apply --allow-destructive
```

Dropping a view, trigger, function, index or type is not gated — those lose a
definition the migration can recreate, not data.

**Fixes run in dependency order.** A function is created before the trigger
that executes it, a column before the index and view that read it, tables
before their foreign keys, and dependants are dropped before what they depend
on. `@dbdiff/cli` emits statements in the order it walks the catalogue, and
applying that order directly failed on sets that were perfectly valid. Preview
the order without running anything:

```bash
supaforge diff --apply --dry-run
```

```
Would apply 3 fix(es), in this order:
  1. [schema] schema-alter-2
     ALTER TABLE "orders" ADD COLUMN "status" text DEFAULT 'pending'::text;
  2. [schema] schema-create-function-7
     CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger ...
  3. [schema] schema-create-trigger-6
     CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders ...

  Nothing was executed. Drop --dry-run to apply.
```

**An apply is all-or-nothing.** PostgreSQL supports transactional DDL, so the
SQL fix set runs in one transaction: if any statement fails, every statement is
rolled back and the target is left exactly as it was. A partial apply would
leave a shared environment matching neither the source nor its own previous
state.

```
Rolled back 5 fix(es) — the target is unchanged:
  ↩ [schema] schema-alter-3
  ...
1 error(s):
  ✗ [schema] schema-create-view-6: relation "active_orders" already exists

  Nothing was written. Re-run with --no-transaction to apply the fixes that do work.
```

Pass `--no-transaction` (or its alias `--continue-on-error`) to run each fix on
its own and keep whatever succeeds. API-based fixes — storage buckets, auth
config — are not transactional, so they are not attempted at all when the SQL
batch rolls back.

### Snapshot & Clone

```bash
# Capture a full snapshot of your remote Supabase (9 layers)
supaforge snapshot --env=prod

# With incremental migration diff (compares against previous snapshot)
supaforge snapshot --env=prod --migration --description="before-deploy"

# Clone remote to local for development
supaforge clone --env=prod --apply

# Manage clones
supaforge clone --list
supaforge clone --delete=my-clone --apply

# Restore into a local database
supaforge restore --env=local --from-snapshot=latest --apply

# Replay migration history
supaforge restore --env=local --from-migrations --apply
```

**Snapshots capture 9 layers**: schema, RLS policies, cron jobs, webhooks, extensions, storage (buckets + policies), auth config, edge functions, and reference data.

**Snapshot pruning**: Use `--prune` to delete old snapshots, keeping the most recent 7 (configurable with `--keep`). Preview mode by default — add `--apply` to execute.

**Migrations are incremental**: `--migration` diffs against the previous snapshot and generates a migration file with UP/DOWN SQL. Migration files are stored in `.supaforge/migrations/`.

**Clone preflight checks**: Before cloning, `supaforge clone` validates that the remote database is reachable, pg_dump is compatible, and the local PostgreSQL server is running. If port 54322 is unreachable, it hints to run `supabase start`.

## Configuration

The fastest way to get started:

```bash
supaforge init          # Interactive wizard — creates config + .env
```

Or copy the annotated example files and fill in your values:

```bash
cp supaforge.config.example.jsonc supaforge.config.json
cp .env.example .env
```

**Key fields**:

| Field | Required | Description |
|-------|----------|-------------|
| `dbUrl` | Yes | PostgreSQL connection string. Use `$VAR` references for secrets. |
| `projectRef` | No | Supabase Project URL (e.g. `https://xyz.supabase.co`) or bare ref. Enables API-based checks (auth, edge functions). |
| `accessToken` | No | Supabase personal access token. Required when `projectRef` is set for Management API checks (auth config, edge functions). |
| `apiUrl` | No | Base URL for self-hosted Supabase API gateway. Use instead of `projectRef` for local/self-hosted. |
| `source` / `target` | Yes | Environment names to compare. Source = truth, target = to be synced. |
| `checks.data.tables` | No | Tables to include in row-level data drift detection. |
| `checks.exclude` | No | Checks to always skip (e.g. `["storage","auth","vault"]`). Useful for clone environments where these checks produce noise. Can also be overridden per-run with `--skip`. |
| `checks.migrations.dir` | No | Directory holding migration files. Defaults to `supabase/migrations`. |
| `checks.migrations.mode` | No | How to report local migration files with no row in `schema_migrations` — `auto` (default), `warn`, or `ignore`. See [Migration history](#migration-history). |

### Migration history

Layer 13 compares migration files in `supabase/migrations/` against the
`supabase_migrations.schema_migrations` table on the target.

That table is a Supabase CLI convention, not a database requirement. A project
that applies migrations another way — `psql`, the SQL editor, another migration
tool — never populates it, so every local file looks unapplied. Reporting each
one individually is noise, not drift.

`checks.migrations.mode` controls this:

| Mode | Behaviour |
| --- | --- |
| `auto` *(default)* | If the tracking table is **empty** but local files exist, report a single INFO noting an untracked migration workflow. Otherwise warn per file. |
| `warn` | Always warn per unrecorded file, even when nothing is tracked. |
| `ignore` | Report nothing from this check. No migration directory read, no query. |

```json
{
  "checks": {
    "migrations": { "mode": "ignore" }
  }
}
```

The collapse in `auto` only applies when *nothing at all* is tracked. A project
that records some migrations and missed others has genuine drift, and still gets
one actionable warning per missing file.

To adopt the tracking table rather than silence the check, `supaforge migrate
baseline` records existing files as applied without executing them.

Sensitive values (`dbUrl`, `accessToken`) support `$VAR` and `${VAR}` syntax — expanded from environment variables at runtime. Store actual credentials in `.env` (already in `.gitignore`).

**`.env` auto-detection**: SupaForge automatically loads `.env` files following the Next.js / Vite / CRA convention:

1. `.env.{NODE_ENV}.local`
2. `.env.local`
3. `.env.{NODE_ENV}`
4. `.env`

Higher-priority files win for duplicate keys. Existing `process.env` values are never overwritten.

See [`supaforge.config.example.jsonc`](supaforge.config.example.jsonc) and [`.env.example`](.env.example) for fully commented examples.

## Workflows

### Multi-DB: Compare Two Environments (Remote ↔ Remote)

The primary use case — detect drift between `dev` and `prod` (or `staging` and `prod`, or any two environments):

```bash
# 1. Set up config with source + target
supaforge init            # Choose "multi" mode, enter two environment URLs

# 2. Check for drift (summary)
supaforge diff
# Output:
#   ✗ DRIFTED (Score: 42/100)
#   ● Schema: 2 issues [CRITICAL]
#   ● RLS:    3 issues [CRITICAL]
#   ● Cron:   1 issue  [WARNING]
#   → Run with --detail to see SQL · --apply to fix

# 3. See the full SQL
supaforge diff --detail

# 4. Apply fixes to the target
supaforge diff --apply

# 5. Verify
supaforge diff
#   ✓ SYNCED (Score: 100/100)
```

**Config** (`supaforge.config.json`):
```json
{
  "environments": {
    "dev": {
      "dbUrl": "$DEV_DATABASE_URL",
      "projectRef": "dev-abc123",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    },
    "prod": {
      "dbUrl": "$PROD_DATABASE_URL",
      "projectRef": "prod-xyz789",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    }
  },
  "source": "dev",
  "target": "prod",
  "checks": {
    "data": { "tables": ["plans", "feature_flags"] }
  }
}
```

### Diffing a Clone (Suppressing Expected Noise)

After `supaforge clone`, the local copy has no Supabase-managed services
(`storage`, `auth`, `edge-functions`, `vault`, `realtime`) — and, because it is
vanilla PostgreSQL, none of Supabase's service roles either, so **Postgres Roles
& Grants** (`roles`) reports every grant referencing one as drift. On a real
clone → remote diff that was 227 findings, the second-largest source of clone
noise after schema; a remote-to-remote diff of the same pair reports zero,
confirming all of them are clone artefacts.

Running `diff` against a clone will always report drift on those six checks. Use
`--skip` to suppress them:

```bash
supaforge diff --skip=storage --skip=auth --skip=edge-functions --skip=vault --skip=realtime --skip=roles
```

Or lock the exclusions in config so you never have to repeat them:

```json
{
  "checks": {
    "exclude": ["storage", "auth", "edge-functions", "vault", "realtime", "roles"]
  }
}
```

Both mechanisms merge — `--skip` on the CLI is unioned with `checks.exclude` from config.

### Single-DB: Snapshot, Clone, Restore (Local ↔ Remote)

Working with a single Supabase environment — no source/target pair needed:

```bash
# 1. Set up config with one environment
supaforge init            # Choose "single" mode

# 2. Capture a full 9-layer snapshot
supaforge snapshot --env=prod

# 3. Track changes over time with incremental migrations
supaforge snapshot --env=prod --migration --description="before-deploy"

# 4. Clone remote to local for development (requires supabase start)
supaforge clone --env=prod --apply

# 5. Restore from a previous snapshot
supaforge restore --env=local --from-snapshot=latest --apply
```

**Config** (`supaforge.config.json`):
```json
{
  "environments": {
    "prod": {
      "dbUrl": "$PROD_DATABASE_URL",
      "projectRef": "prod-xyz789",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    }
  }
}
```

**Available commands by config mode:**

| Command | Multi-DB | Single-DB |
|---------|----------|-----------|
| `diff` | ✅ Compares source → target | ✗ Requires two environments |
| `snapshot` | ✅ Any environment | ✅ |
| `clone` | ✅ Any environment → local | ✅ |
| `restore` | ✅ | ✅ |
| `hukam` | ✅ Alias for diff | ✗ |

### CI/CD Integration

```yaml
# .github/workflows/drift-check.yml
- name: Check for drift
  env:
    DEV_DATABASE_URL: ${{ secrets.DEV_DATABASE_URL }}
    PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  run: npx supaforge diff --check
```

The `--check` flag exits with code 1 when drift is detected, failing the pipeline.

## Extending with Hooks

SupaForge includes a lightweight hook bus for extensibility:

```typescript
import { HookBus, scan, createDefaultRegistry, loadConfig } from '@akalforge/supaforge'

const bus = new HookBus()

bus.on('supaforge.scan.before', (ctx) => {
  console.log(`Scanning ${ctx.config.source} → ${ctx.config.target}`)
})

bus.on('supaforge.check.after', ({ check, result }) => {
  if (result.status === 'drifted') {
    console.log(`⚠ Drift detected in ${check}`)
  }
})

const config = await loadConfig()
const registry = createDefaultRegistry()
const result = await scan(registry, { config }, bus)
```

## Development

```bash
cd packages/cli
npm install
npm test

# Run in dev mode
./bin/dev.js diff
```

### Integration Tests (Docker / Podman)

Integration tests run against real Supabase Postgres containers. The test script auto-detects Docker or Podman:

```bash
# Full flow: start containers → seed → test → teardown
npm run test:integration

# Keep containers running for debugging
./scripts/test-integration.sh --no-teardown

# Force a specific compose command
COMPOSE_CMD="podman-compose" npm run test:integration
```

You can also start the containers manually and run the tests separately:

```bash
# Start containers (works with Docker Compose v2, docker-compose, or podman-compose)
docker compose -f tests/docker-compose.test.yml up -d

# Wait for Postgres to be ready
until psql postgresql://postgres:source-test-pass@localhost:15432/postgres -c 'SELECT 1' 2>/dev/null; do sleep 1; done
until psql postgresql://postgres:target-test-pass@localhost:15433/postgres -c 'SELECT 1' 2>/dev/null; do sleep 1; done

# Seed
psql postgresql://postgres:source-test-pass@localhost:15432/postgres -f tests/fixtures/seed-source.sql
psql postgresql://postgres:target-test-pass@localhost:15433/postgres -f tests/fixtures/seed-target.sql

# Run integration tests
SUPAFORGE_TEST_SOURCE_URL=postgresql://postgres:source-test-pass@localhost:15432/postgres \
SUPAFORGE_TEST_TARGET_URL=postgresql://postgres:target-test-pass@localhost:15433/postgres \
npx vitest run --config vitest.integration.config.ts

# Teardown
docker compose -f tests/docker-compose.test.yml down -v
```

### CLI e2e Tests

```bash
npm run test:e2e
```

### E2E Tests (Supabase)

Full end-to-end tests against two real Supabase local instances (source = dev, target = prod). Tests the
complete scan → promote → re-scan roundtrip for RLS, Cron, Webhooks, and Storage checks.

**Requirements**: Supabase CLI, Docker (or Podman with docker compat), psql, curl.

```bash
# Full flow: start instances → seed → test → teardown
npm run test:e2e:supabase

# Keep instances running for debugging
./scripts/test-e2e.sh --no-teardown

# Reuse already-running instances
./scripts/test-e2e.sh --skip-start
```

Port allocation:
- Source: API 54321, DB 54322
- Target: API 55321, DB 55322

### @dbdiff/cli Integration

The Schema and Data checks are powered by [`@dbdiff/cli`](https://github.com/DBDiff/DBDiff). It is included as a dependency and installed automatically — no separate install needed. The native binary runs without PHP.

```bash
supaforge diff                # schema + data checks active out of the box
```

The adapter (`src/dbdiff.ts`) resolves the local `@dbdiff/cli` binary, invokes it directly (no `npx`), and parses the UP/DOWN marker output into `DriftIssue` objects.

**Overloaded functions.** Postgres lets several functions share a name with
different argument types. Each overload is compared and reported separately, and
is identified by its signature — `Function modified: public.dist(text,text)` —
so two overloads of one name are distinguishable in the output and the generated
migration touches only the one that actually drifted. This needs
`@dbdiff/cli` 3.0.0-rc.7 or newer; earlier versions saw only one overload per
name and missed drift in the rest.

**Schema diff performance.** DBDiff compares table schemas in a constant number
of round-trips rather than one set per table: it first hashes every table's
schema in a single query per side and skips the ones that match, then loads the
remainder in a fixed 7 queries per side. On a Supabase project where most tables
are unchanged, this is the difference between thousands of round-trips and a
couple of dozen. Nothing to configure — it is on for Postgres automatically.

If a diff still struggles on a very large schema, raise the ceilings rather than
narrowing the scan:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPAFORGE_DBDIFF_TIMEOUT` | `600` | Seconds before a diff is abandoned. Overrides `checks.schema.timeout` |
| `SUPAFORGE_DBDIFF_MEMORY` | dbdiff's own `1G` | Passed to `--memory-limit`; takes `512M`, `2G`, or `-1` for unlimited |
| `SUPAFORGE_CONNECT_TIMEOUT` | `15` | Seconds before a database connection attempt is abandoned. Applies to every connection, including the preflight reachability check |

```bash
SUPAFORGE_DBDIFF_TIMEOUT=600 SUPAFORGE_DBDIFF_MEMORY=2G supaforge diff
```

**Per-environment overrides.** `checks.exclude` and `checks.schema.timeout` can
be set on an individual environment, applying when it is the diff target and
unioned with the top-level config. Timeout precedence is
`SUPAFORGE_DBDIFF_TIMEOUT` → `checks.schema.timeout` → the 600s default.

**Progress.** On a TTY the schema check reports a live table counter while it
runs, so a long diff reads as working rather than hung. Suppressed under
`--json`, `--ci`, and when output is piped.

**Destructive changes.** DBDiff refuses by default to generate a migration that
drops a table or column. SupaForge passes `--allow-destructive` when invoking it,
because detecting an extra table on the target is the whole point of a drift
check — reporting it must not be a hard failure. The safety gate is applied at
*apply* time instead, in `promote()`, which skips those statements unless you
pass `--allow-destructive` to SupaForge itself. See
[Safe by Default](#safe-by-default).

## License

MIT
