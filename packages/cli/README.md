# supaforge

> Diff and sync your Supabase environments.

Built by [Akal Forge](https://github.com/akalforge). Powered by [oclif](https://oclif.io).

## Quick Start

```bash
npm install -g supaforge

# Create config
cat > supaforge.config.json << 'EOF'
{
  "environments": {
    "dev": {
      "dbUrl": "postgres://postgres:pass@db.DEV.supabase.co:5432/postgres",
      "projectRef": "your-dev-ref",
      "apiKey": "your-dev-service-role-key"
    },
    "prod": {
      "dbUrl": "postgres://postgres:pass@db.PROD.supabase.co:5432/postgres",
      "projectRef": "your-prod-ref",
      "apiKey": "your-prod-service-role-key"
    }
  },
  "source": "dev",
  "target": "prod"
}
EOF

# Scan for drift
supaforge scan

# Show detailed diff with SQL fixes
supaforge diff
```

## Comprehensive Checks

| Check | Source | Detection | Fix |
|-------|--------|-----------|-----|
| Schema | `@dbdiff/cli` | ✅ Tables, views, triggers, functions, enum types | SQL (up/down) |
| Data | `@dbdiff/cli --type=data` | ✅ Row-level diff for all public tables (configurable) | SQL (up/down) |
| RLS Policies | `pg_policies` view | ✅ | SQL (up/down) |
| Edge Functions | Management API | ✅ | DELETE extras via API; missing/outdated → manual `supabase functions deploy` |
| Storage | Storage API + `pg_policies` | ✅ | Buckets via API (POST/PUT/DELETE); Policies via SQL |
| Auth Config | Management API | ✅ | PATCH via API |
| Cron Jobs | `cron.job` table | ✅ | SQL (up/down) |
| Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ | SQL when trigger metadata available |
| Realtime Publications | `pg_publication` + `pg_publication_tables` | ✅ | SQL (CREATE/ALTER PUBLICATION) |
| Vault Secrets | `vault.secrets` | ✅ | SQL (`vault.create_secret` / `vault.update_secret`) |
| Postgres Extensions | `pg_extension` | ✅ | SQL (CREATE/DROP EXTENSION) |

## Commands

```
supaforge scan                          Scan everything
supaforge scan --check=rls              Scan a specific check only
supaforge scan --json                   Output as JSON
supaforge diff                          Show detailed diff with SQL fixes
supaforge diff --check=rls              Detailed diff for one check
supaforge promote                       Preview fixes for the target environment
supaforge promote --apply               Actually execute the fixes (SQL + API)
supaforge promote --check=rls --apply   Only promote one check
supaforge hukam                         Alias for scan 🙏
supaforge snapshot --env=prod           Preview what a snapshot would capture
supaforge snapshot --env=prod --apply   Capture a full environment snapshot (9 layers)
supaforge snapshot --list               List all snapshots
supaforge clone --env=prod              Preview a clone operation
supaforge clone --env=prod --apply      Clone remote env to local (snapshot + branch + baseline)
supaforge backup --env=prod             Preview a backup operation
supaforge backup --env=prod --apply     Capture snapshot + generate incremental migration
supaforge backup --list                 List all migration files
supaforge restore --env=local --from-snapshot  Preview snapshot restore
supaforge restore --env=local --apply   Apply restore to target database
supaforge branch create <name>          Preview branch creation
supaforge branch create <name> --apply  Create a database branch from source
supaforge branch create <name> --from=prod --apply  Branch from a specific environment
supaforge branch list                   List all tracked branches
supaforge branch delete <name>          Preview branch deletion
supaforge branch delete <name> --apply  Drop branch database and remove tracking
supaforge branch diff <name>            Compare branch against source environment
supaforge branch diff <name> --against=prod  Compare against a specific environment
```

### Database Branching

SupaForge provides lightweight database branching for self-hosted and local Supabase setups — similar to Neon or Dolt, but using `pg_dump`/`pg_restore` so it works anywhere you have a PostgreSQL connection string.

```bash
# Create a branch (copies the entire database)
supaforge branch create feature-x

# Or branch from a specific environment, schema only
supaforge branch create feature-x --from=production --schema-only

# See what changed on the branch vs the source environment
supaforge branch diff feature-x

# List all branches
supaforge branch list

# Clean up
supaforge branch delete feature-x
```

**How it works:**
1. `branch create` tries `CREATE DATABASE ... TEMPLATE` (instant, local/self-hosted) first.
2. Falls back to `pg_dump | pg_restore` (works for remote connections, busy databases).
3. Branch metadata is tracked in `.supaforge/branches.json`.
4. `branch diff` delegates to the same check scanner, comparing the branch database against any environment.

> **Note**: Supabase Cloud managed databases may not grant `CREATEDB` privileges. Branching works best with self-hosted Supabase or local development (`supabase start`).

### Snapshot, Clone & Backup

Single-environment commands for solo developers or production backup workflows:

```bash
# Capture a full snapshot of your remote Supabase (9 layers)
supaforge snapshot --env=prod --apply

# Clone remote to local for development
supaforge clone --env=prod --apply

# Incremental backup (snapshot + diff migration)
supaforge backup --env=prod --apply --description="before-deploy"

# Restore into a local database
supaforge restore --env=local --from-snapshot --apply

# Replay migration history
supaforge restore --env=local --from-migrations --apply
```

**Snapshots capture 9 layers**: schema, RLS policies, cron jobs, webhooks, extensions, storage (buckets + policies), auth config, edge functions, and reference data.

**Backups are incremental**: each backup diffs against the previous snapshot and generates a migration file with UP/DOWN SQL. Migration files are stored in `.supaforge/migrations/`.

### Safe by Default

All commands that modify databases or external state preview what they would do by default. Add `--apply` to execute:

```bash
# Preview only (default)
supaforge promote
supaforge branch create feature-x
supaforge snapshot --env=prod

# Actually execute
supaforge promote --apply
supaforge branch create feature-x --apply
supaforge snapshot --env=prod --apply
```

## Configuration

`supaforge.config.json` in your project root:

```json
{
  "environments": {
    "dev": {
      "dbUrl": "postgres://...",
      "projectRef": "abc123",
      "apiKey": "your-service-role-key"
    },
    "prod": {
      "dbUrl": "postgres://...",
      "projectRef": "xyz789",
      "apiKey": "your-service-role-key"
    }
  },
  "source": "dev",
  "target": "prod",
  "ignoreSchemas": ["auth", "storage", "realtime", "vault"],
  "checks": {
    "data": {
      "tables": ["plans", "feature_flags", "pricing_tiers"]
    }
  }
}
```

**Self-hosted Supabase**: Use `apiUrl` instead of `projectRef` to point at your local API gateway:

```json
{
  "environments": {
    "local": {
      "dbUrl": "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "apiKey": "your-service-role-key",
      "apiUrl": "http://127.0.0.1:54321"
    }
  }
}
```

Supabase internal schemas (`auth`, `storage`, `realtime`, `vault`, etc.) are ignored by default.

## Extending with Hooks

SupaForge includes a lightweight hook bus for extensibility:

```typescript
import { HookBus, scan, createDefaultRegistry, loadConfig } from 'supaforge'

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
./bin/dev.js scan
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
supaforge scan                # schema + data checks active out of the box
```

The adapter (`src/dbdiff.ts`) resolves the local `@dbdiff/cli` binary, invokes it directly (no `npx`), and parses the UP/DOWN marker output into `DriftIssue` objects.

## License

MIT
