# supaforge

> Detect and fix drift across all your Supabase environments — the environment sync tool Supabase developers have been asking for.

Built by [Akal Forge](https://github.com/akalforge). Powered by [oclif](https://oclif.io). Extensible via hooks inspired by [@plug/core](https://github.com/akalforge/plug).

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

## The 8 Drift Layers

| # | Layer | Source | Detection | Fix |
|---|-------|--------|-----------|-----|
| 1 | Schema | `@dbdiff/cli` | ✅ | SQL (up/down) |
| 2 | RLS Policies | `pg_policies` view | ✅ | SQL (up/down) |
| 3 | Edge Functions | Management API | ✅ | DELETE extras via API; missing/outdated → manual `supabase functions deploy` |
| 4 | Storage | Storage API + `pg_policies` | ✅ | Buckets via API (POST/PUT/DELETE); Policies via SQL |
| 5 | Auth Config | Management API | ✅ | PATCH via API |
| 6 | Cron Jobs | `cron.job` table | ✅ | SQL (up/down) |
| 7 | Reference Data | `@dbdiff/cli --type=data` | ✅ | SQL (up/down) |
| 8 | Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ | SQL when trigger metadata available |

## Commands

```
supaforge scan                          Scan all 8 layers for drift
supaforge scan --layer=rls              Scan a specific layer only
supaforge scan --json                   Output as JSON
supaforge diff                          Show detailed diff with SQL fixes
supaforge diff --layer=rls              Detailed diff for one layer
supaforge promote                       Apply fixes to the target environment (SQL + API)
supaforge promote --dry-run             Show fixes that would be applied
supaforge promote --layer=rls           Only promote one layer
supaforge hukam                         Alias for scan 🙏
supaforge branch create <name>          Create a database branch from source
supaforge branch create <name> --from=prod  Branch from a specific environment
supaforge branch create <name> --schema-only  Copy schema only (no data)
supaforge branch list                   List all tracked branches
supaforge branch delete <name>          Drop branch database and remove tracking
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
4. `branch diff` delegates to the same 8-layer scanner, comparing the branch database against any environment.

> **Note**: Supabase Cloud managed databases may not grant `CREATEDB` privileges. Branching works best with self-hosted Supabase or local development (`supabase start`).

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
  "layers": {
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

SupaForge uses a hook bus (inspired by [@plug/core](https://github.com/akalforge/plug)) for extensibility:

```typescript
import { HookBus, scan, createDefaultRegistry, loadConfig } from 'supaforge'

const bus = new HookBus()

bus.on('supaforge.scan.before', (ctx) => {
  console.log(`Scanning ${ctx.config.source} → ${ctx.config.target}`)
})

bus.on('supaforge.layer.after', ({ layer, result }) => {
  if (result.status === 'drifted') {
    console.log(`⚠ Drift detected in ${layer}`)
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
# Start containers
docker compose -f tests/docker-compose.test.yml up -d --wait  # or podman-compose

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
complete scan → promote → re-scan roundtrip for RLS, Cron, Webhooks, and Storage layers.

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

Layers 1 (Schema) and 7 (Reference Data) shell out to `@dbdiff/cli`. When it's not installed, the layers gracefully return zero issues. Once `@dbdiff/cli` is published to npm:

```bash
npm install -g @dbdiff/cli   # or add to project devDependencies
supaforge scan                # schema + data layers now active
```

The adapter (`src/dbdiff.ts`) parses the UP/DOWN marker output from `@dbdiff/cli` and converts SQL statements into `DriftIssue` objects.

## License

MIT
