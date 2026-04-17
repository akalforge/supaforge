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
| Edge Functions | Management API | ✅ | DELETE extras via API; missing/outdated → manual `supabase functions deploy` |
| Storage | Storage API + `pg_policies` | ✅ Buckets, policies. `--include-files` adds file-level drift detection (checksums for JSON, size/date for binary). | Buckets via API (POST/PUT/DELETE); Policies via SQL |
| Auth Config | Management API | ✅ | PATCH via API |
| Cron Jobs | `cron.job` table | ✅ | SQL (up/down) |
| Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ | SQL when trigger metadata available |
| Realtime Publications | `pg_publication` + `pg_publication_tables` | ✅ | SQL (CREATE/ALTER PUBLICATION) |
| Vault Secrets | `vault.secrets` | ✅ | SQL (`vault.create_secret` / `vault.update_secret`) |
| Postgres Extensions | `pg_extension` | ✅ | SQL (CREATE/DROP EXTENSION) |

## Commands

```
supaforge init                          Create supaforge.config.json interactively
supaforge init --force                  Overwrite existing config file

supaforge diff                          Summary: what's drifted? (score + pass/fail)
supaforge diff --detail                 Show detailed SQL diffs
supaforge diff --apply                  Apply SQL + API fixes to the target environment
supaforge diff --check=rls              Limit to a specific check
supaforge diff --check=rls --apply      Fix only one check
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
  "checks": { "data": { "tables": ["plans", "feature_flags"] } }
}
```

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

## License

MIT
