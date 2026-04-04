# SupaForge

> Detect and fix drift across all your Supabase environments — the environment sync tool Supabase developers have been asking for.

[![CI](https://github.com/akalforge/supaforge/actions/workflows/ci.yml/badge.svg)](https://github.com/akalforge/supaforge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/supaforge.svg)](https://www.npmjs.com/package/supaforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why SupaForge?

Supabase projects running in multiple environments (dev, staging, production) silently diverge across **eight distinct layers** — schema, RLS policies, Edge Functions, storage, auth, cron jobs, reference data, and webhooks — with no first-class tooling to detect or fix it.

**CVE-2025-48757** found 170+ apps with fully exposed databases due to RLS policies that were never promoted to production. SupaForge catches this on the first scan.

Built by **[Akal Forge](https://github.com/akalforge)** — precision developer tools, forged to last.

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
| 1 | Schema | `@dbdiff/cli` | ✅ Ready |
| 2 | RLS Policies | `pg_policies` view | ✅ Ready |
| 3 | Edge Functions | Management API | ✅ Ready |
| 4 | Storage | Storage API | ✅ Ready |
| 5 | Auth Config | Management API | ✅ Ready |
| 6 | Cron Jobs | `cron.job` table | ✅ Ready |
| 7 | Reference Data | `@dbdiff/cli --type=data` | ✅ Ready |
| 8 | Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ Ready |

## Commands

```
supaforge scan              Scan all 8 layers for drift
supaforge scan --layer=rls  Scan a specific layer only
supaforge scan --json       Output as JSON
supaforge diff              Show detailed diff with SQL fixes
supaforge diff --layer=rls  Detailed diff for one layer
supaforge hukam             Alias for scan 🙏
```

## Configuration

Create `supaforge.config.json` in your project root:

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

SupaForge uses a hook bus inspired by [@plug/core](https://github.com/akalforge/plug) for extensibility:

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

## Architecture

```
packages/cli/
├── src/
│   ├── commands/        # oclif commands (scan, diff, hukam)
│   ├── layers/          # 8 drift detection layers
│   │   ├── base.ts      # Abstract Layer class
│   │   ├── registry.ts  # LayerRegistry
│   │   ├── rls.ts       # RLS policy diffing
│   │   ├── cron.ts      # Cron job diffing
│   │   └── ...          # edge-functions, storage, auth, webhooks, schema, data
│   ├── types/           # TypeScript interfaces
│   ├── config.ts        # Config loader + validator
│   ├── hooks.ts         # HookBus (actions + filters)
│   ├── scanner.ts       # Scan orchestrator
│   ├── scoring.ts       # Health score (0–100)
│   └── render.ts        # Terminal output
└── test/                # 58 tests across 7 suites
```

## Development

```bash
git clone https://github.com/akalforge/supaforge.git
cd supaforge/packages/cli
npm install
npm test       # Run all tests (168 unit + e2e)
npm run lint   # Type-check
npm run build  # Build with tsup

# Run in dev mode
./bin/dev.js scan
```

### Integration Tests (Docker / Podman)

Integration tests run against real Postgres containers and verify the full stack including `@dbdiff/cli`:

```bash
# Full flow: start containers → seed → test → teardown
npm run test:integration

# Keep containers running for debugging
./scripts/test-integration.sh --no-teardown
```

See [`packages/cli/README.md`](packages/cli/README.md#integration-tests-docker--podman) for manual setup and more options.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and pull request guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — Copyright (c) 2026 Akal Forge
