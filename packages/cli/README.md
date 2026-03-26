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

# The daily Hukamnama of your database 🙏
supaforge hukam
```

## The 8 Drift Layers

| # | Layer | Source | Status |
|---|-------|--------|--------|
| 1 | Schema | `@dbdiff/cli` | ✅ Integrated (activates when `@dbdiff/cli` is installed) |
| 2 | RLS Policies | `pg_policies` view | ✅ Ready |
| 3 | Edge Functions | Management API | ✅ Ready |
| 4 | Storage | Storage API | ✅ Ready |
| 5 | Auth Config | Management API | ✅ Ready |
| 6 | Cron Jobs | `cron.job` table | ✅ Ready |
| 7 | Reference Data | `@dbdiff/cli --type=data` | ✅ Integrated (activates when `@dbdiff/cli` is installed) |
| 8 | Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ Ready |

## Commands

```
supaforge scan              Scan all 8 layers for drift
supaforge scan --layer=rls  Scan a specific layer only
supaforge scan --json       Output as JSON
supaforge diff              Show detailed diff with SQL fixes
supaforge diff --layer=rls  Detailed diff for one layer
supaforge promote           Apply SQL fixes to the target environment
supaforge promote --dry-run Show SQL that would be applied
supaforge promote --layer=rls  Only promote one layer
supaforge hukam             Alias for scan 🙏
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
  "layers": {
    "data": {
      "tables": ["plans", "feature_flags", "pricing_tiers"]
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

### @dbdiff/cli Integration

Layers 1 (Schema) and 7 (Reference Data) shell out to `@dbdiff/cli`. When it's not installed, the layers gracefully return zero issues. Once `@dbdiff/cli` is published to npm:

```bash
npm install -g @dbdiff/cli   # or add to project devDependencies
supaforge scan                # schema + data layers now active
```

The adapter (`src/dbdiff.ts`) parses the UP/DOWN marker output from `@dbdiff/cli` and converts SQL statements into `DriftIssue` objects.

## License

MIT
