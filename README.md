# SupaForge

> Diff and sync your Supabase environments.

[![CI](https://github.com/akalforge/supaforge/actions/workflows/ci.yml/badge.svg)](https://github.com/akalforge/supaforge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@akalforge/supaforge.svg)](https://www.npmjs.com/package/@akalforge/supaforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why SupaForge?

Supabase projects running in multiple environments (dev, staging, production) silently diverge with no first-class tooling to detect or fix it.

**CVE-2025-48757** found 170+ apps with fully exposed databases due to RLS policies that were never promoted to production. SupaForge catches this on the first scan.

Built by **[Akal Forge](https://github.com/akalforge)** — precision developer tools, forged to last.

## Quick Start

```bash
npm install -g @akalforge/supaforge

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

## Comprehensive Checks

| Check | Source | Status |
|-------|--------|--------|
| Schema | `@dbdiff/cli` | ✅ Ready |
| Data | `@dbdiff/cli --type=data` | ✅ Ready |
| RLS Policies | `pg_policies` view | ✅ Ready |
| Edge Functions | Management API | ✅ Ready |
| Storage | Storage API | ✅ Ready |
| Auth Config | Management API | ✅ Ready |
| Cron Jobs | `cron.job` table | ✅ Ready |
| Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ Ready |
| Realtime Publications | `pg_publication` + `pg_publication_tables` | ✅ Ready |
| Vault Secrets | `vault.secrets` | ✅ Ready |
| Postgres Extensions | `pg_extension` | ✅ Ready |

## Supabase Feature Coverage

How SupaForge maps to every standard Supabase module (see [Supabase Features](https://supabase.com/docs/guides/getting-started/features)):

| Supabase Module | Feature | SupaForge Check | Notes |
|---|---|---|---|
| **Database** | Postgres schema | ✅ Schema | Tables, columns, indexes, constraints, views, triggers, functions, sequences |
| | Reference / seed data | ✅ Data | Row-level diff for all public tables (configurable) |
| | Database webhooks | ✅ Webhooks | `supabase_functions.hooks` + `pg_net` extension |
| | Postgres extensions | ✅ Extensions | Enabled/disabled detection via `pg_extension` |
| | Vault / Secrets | ✅ Vault | Secret name/description drift; values are environment-specific |
| | Postgres roles | 🔜 Planned | Custom roles and grants |
| | Realtime publications | ✅ Realtime | Which tables are published for Realtime |
| | PostgREST config | ⬜ Not planned | Managed by Supabase platform; not user-configurable per environment |
| | Replication | ⬜ Not planned | Private alpha; not accessible via standard APIs |
| **Auth** | Auth config | ✅ Auth | 20+ settings via Management API (providers, JWT, MFA, CAPTCHA) |
| | RLS policies | ✅ RLS | Full policy diffing with UP/DOWN SQL generation |
| **Storage** | Buckets | ✅ Storage | Bucket metadata (name, public/private, size limits, MIME types) |
| | Storage RLS policies | ✅ Storage | `storage` schema policy diffing |
| **Edge Functions** | Function metadata | ✅ Edge Functions | Slug, version, status (source code requires manual deploy) |
| **Cron** | `pg_cron` jobs | ✅ Cron | Schedule, command, active status with SQL generation |
| **Realtime** | Publications | ✅ Realtime | `pg_publication` + `pg_publication_tables` |
| | Broadcast / Presence | ⬜ N/A | Runtime features, not environment config |
| **Platform** | Network restrictions | ⬜ N/A | Platform-level (not diffable via SQL or Management API) |
| | SSL enforcement | ⬜ N/A | Platform-level |
| | Custom domains | ⬜ N/A | Platform-level |
| | Branching | ⬜ N/A | SupaForge provides its own branching via `supaforge branch` |
| | Read replicas | ⬜ N/A | Platform-level |

✅ = Covered &nbsp; 🔜 = Planned &nbsp; ⬜ = Not applicable / not planned

## Commands

```
supaforge scan              Scan everything
supaforge scan --check=rls  Scan a specific check only
supaforge scan --json       Output as JSON
supaforge diff              Show detailed diff with SQL fixes
supaforge diff --check=rls  Detailed diff for one check
supaforge promote           Preview fixes (dry-run by default)
supaforge promote --apply   Actually execute fixes
supaforge hukam             Alias for scan 🙏

# Single-environment (backup & restore)
supaforge snapshot --env=prod --apply   Capture full 9-layer snapshot
supaforge clone --env=prod --apply      Clone remote to local
supaforge backup --env=prod --apply     Incremental backup (snapshot + diff)
supaforge restore --env=local --apply   Restore from snapshot or migrations

# Branching
supaforge branch create feature-x --apply
supaforge branch list
supaforge branch diff feature-x
supaforge branch delete feature-x --apply
```

> All commands that modify state preview by default. Add `--apply` to execute.

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
  "checks": {
    "data": {
      "tables": ["plans", "feature_flags", "pricing_tiers"]
    }
  }
}
```

Supabase internal schemas (`auth`, `storage`, `realtime`, `vault`, etc.) are ignored by default.

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

## Architecture

```
packages/cli/
├── src/
│   ├── commands/        # oclif commands (scan, diff, hukam)
│   ├── checks/          # Drift detection checks
│   │   ├── base.ts      # Abstract Check class
│   │   ├── registry.ts  # CheckRegistry
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
npm test       # Run all tests (220 unit + e2e)
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

### Releasing

Releases are dry-run by default. Pass `--apply` to publish for real.

```bash
node scripts/release.js patch             # Dry-run: 0.0.1 → 0.0.2
node scripts/release.js minor             # Dry-run: 0.0.1 → 0.1.0
node scripts/release.js prerelease        # Dry-run: 0.0.1 → 0.0.2-rc.1
node scripts/release.js prerelease --preid=beta  # Dry-run: → 0.0.2-beta.1
node scripts/release.js 1.0.0-rc.1       # Dry-run: explicit version

node scripts/release.js patch --apply     # Actually bump, commit, tag, push
```

The tag push triggers `.github/workflows/release.yml` which publishes to npm and GitHub Packages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and pull request guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — Copyright (c) 2026 Akal Forge
