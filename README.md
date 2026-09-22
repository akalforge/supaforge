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

# Create config interactively
supaforge init

# Check for drift
supaforge diff

# Show detailed SQL diffs
supaforge diff --detail

# Fix the drift
supaforge diff --apply

# Alias for diff
supaforge hukam
```

## Single Database

Only have one Supabase project? SupaForge works as a snapshot, backup, and audit tool for a single remote database — no second environment needed.

```bash
npm install -g @akalforge/supaforge

# Interactive setup — choose "single" mode
supaforge init

# Or create config manually
cat > supaforge.config.json << 'EOF'
{
  "environments": {
    "prod": {
      "dbUrl": "$PROD_DATABASE_URL",
      "projectRef": "https://your-project.supabase.co",
      "accessToken": "$SUPABASE_ACCESS_TOKEN"
    }
  }
}
EOF

# Capture a full snapshot (schema, RLS, cron, storage, auth, etc.)
supaforge snapshot --env=prod

# Clone remote to local for development
supaforge clone --env=prod --apply

# Incremental backup (snapshot + migration file)
supaforge snapshot --env=prod --migration
```

> Single-database configs omit `source` and `target`. The `diff` command requires two environments — use `snapshot`, `clone`, and `restore` instead.

## Comprehensive Checks

| Check | Source | Status |
|-------|--------|--------|
| Schema | `@dbdiff/cli` | ✅ Ready |
| Data | `@dbdiff/cli --type=data` | ✅ Ready |
| RLS Policies | `pg_policies` view | ✅ Ready |
| Edge Functions | Management API (hosted), Studio's functions API or the functions directory (self-hosted) | ✅ Ready |
| Storage | Storage API | ✅ Ready |
| Auth Config | Management API, or GoTrue `/auth/v1/settings` when `apiUrl` is set | ✅ Ready |
| Cron Jobs | `cron.job` table | ✅ Ready |
| Webhooks | `supabase_functions.hooks` + `pg_net` | ✅ Ready |
| Realtime | `pg_publication` + `pg_publication_tables`, and `pg_policies` on `realtime` | ✅ Ready — publications and Realtime Authorization policies |
| Vault Secrets | `vault.secrets` | ✅ Ready |
| Postgres Extensions | `pg_extension` | ✅ Ready |
| RLS Coverage | `pg_class.relrowsecurity` | ✅ Ready — target only, scored as posture |
| Migration History | `supabase_migrations.schema_migrations` | ✅ Ready — target only, scored as posture |
| Postgres Roles & Grants | `pg_roles` + `information_schema` grants | ✅ Ready |

## Supabase Feature Coverage

How SupaForge maps to every standard Supabase module (see [Supabase Features](https://supabase.com/docs/guides/getting-started/features)):

| Supabase Module | Feature | SupaForge Check | Notes |
|---|---|---|---|
| **Database** | Postgres schema | ✅ Schema | Tables, columns, indexes, constraints, views, triggers, functions, standalone sequences, enum and composite types, domains, materialized views |
| | Reference / seed data | ✅ Data | Row-level diff for all public tables (configurable) |
| | Database webhooks | ✅ Webhooks | `supabase_functions.hooks` + `pg_net` extension |
| | Postgres extensions | ✅ Extensions | Enabled/disabled detection via `pg_extension` |
| | Vault / Secrets | ✅ Vault | Secret name/description drift; values are environment-specific |
| | Postgres roles | ✅ Roles | Custom role attributes and table grants. Supabase's own service roles are excluded |
| | Realtime publications | ✅ Realtime | Which tables are published for Realtime |
| | PostgREST config | ⬜ Not planned | Managed by Supabase platform; not user-configurable per environment |
| | Replication | ⬜ Not planned | Private alpha; not accessible via standard APIs |
| **Auth** | Auth config | ✅ Auth | 20+ settings via Management API (providers, JWT, MFA, CAPTCHA) |
| | RLS policies | ✅ RLS | Full policy diffing with UP/DOWN SQL generation |
| **Storage** | Buckets | ✅ Storage | Bucket metadata (name, public/private, size limits, MIME types), including analytics and vector buckets. Objects are never transferred |
| | Storage RLS policies | ✅ Storage | `storage` schema policy diffing |
| **Edge Functions** | Function metadata | ✅ Edge Functions | Inventory plus a hash per function, so changed module contents are detected. Deploying is still manual — each issue carries the command |
| **Cron** | `pg_cron` jobs | ✅ Cron | Schedule, command, active status with SQL generation |
| **Realtime** | Publications | ✅ Realtime | `pg_publication` + `pg_publication_tables` |
| | Realtime Authorization | ✅ Realtime | Policies on `realtime.messages` — who may join which channel |
| | Broadcast / Presence | ⬜ N/A | Runtime features, not environment config |
| **Platform** | Network restrictions | ⬜ N/A | Platform-level (not diffable via SQL or Management API) |
| | SSL enforcement | ⬜ N/A | Platform-level |
| | Custom domains | ⬜ N/A | Platform-level |
| | Branching | ⬜ N/A | SupaForge provides its own cloning via `supaforge clone` |
| | Read replicas | ⬜ N/A | Platform-level |

✅ = Covered &nbsp; 🔜 = Planned &nbsp; ⬜ = Not applicable / not planned

## Commands

```
supaforge init                            Create config interactively
supaforge diff                            Summary: what's drifted?
supaforge diff --detail                   Show detailed SQL diffs
supaforge diff --apply                    Fix the drift
supaforge diff --dry-run                  Preview the fixes, in execution order
supaforge diff --apply --only=schema-alter-2   Apply one reviewed issue by id
supaforge diff --fail-on-posture          Let target-only findings set the exit code
supaforge diff --check=rls                Limit to a specific check
supaforge diff --skip=storage             Skip a specific check
supaforge diff --skip=auth --skip=vault   Skip multiple checks (repeatable)
supaforge diff --apply --prove            Prove the migration on a throwaway clone first
supaforge diff --apply --apply-posture    Also apply target-only (posture) fixes
supaforge diff --ci                       CI mode: annotations + semantic exit codes
supaforge diff --ci --fail-on=warning     Fail on WARNING as well as CRITICAL
supaforge sync                            Alias for diff --apply
supaforge hukam                           Alias for diff 🙏

supaforge snapshot                        Capture full 9-layer snapshot
supaforge snapshot --migration            Also generate incremental migration diff
supaforge snapshot --list                 List all snapshots
supaforge snapshot --prune --apply        Delete old snapshots

supaforge clone --env=prod                Preflight checks
supaforge clone --env=prod --apply        Clone remote to local
supaforge clone --env=prod --force        Force re-clone (drop existing DB)
supaforge clone --env=prod --start-local  Auto-start a local PostgreSQL container
supaforge clone --list                    List existing clones
supaforge clone --delete=<name> --apply   Remove a clone

supaforge restore --env=local --from-snapshot=latest --apply   Restore from snapshot
supaforge restore --env=local --from-migrations --apply        Replay migrations

supaforge migrate create --name=add_orders   Generate a migration file from schema drift
supaforge migrate list                    List local migrations, applied and pending
supaforge migrate run --dry-run           Preview which migrations would run
supaforge migrate run                     Execute pending migrations
supaforge migrate baseline                Mark local migrations applied without running them

supaforge report                          Show recent command history from the local run log
supaforge report --send                   Choose entries to send as anonymous bug reports

supaforge mcp                             Start MCP stdio server for AI agents
```

> `diff`, `clone`, `restore` and `snapshot` preview by default — add `--apply`
> to execute. The `migrate` family is the exception: `migrate run`
> executes unless you pass `--dry-run`, and `migrate baseline` only writes
> tracking rows, so it has no preview mode.
>
> Fixes that destroy rows — dropping a table or a column — are always reported
> but never applied by `--apply` alone. They are listed as skipped unless you
> also pass `--allow-destructive`.
>
> `report` reads a local run log and prints it. Only `report --send` leaves the
> machine, and only for the entries you pick: it shows exactly what would be
> transmitted and asks first. No SQL, table names or schema content is included.

### How `--apply` executes

Three things decide what a `--apply` run does, beyond which checks it covers.

**Order.** Fixes run in dependency order, not in the order the checks reported
them: base objects before the things built on them, and dependants dropped
before what they depend on. A function is created before the trigger that
executes it, a column before the index and view that read it, and the
destructive drops go last. `@dbdiff/cli` emits statements in the order it walks
the catalogue, which carries no such guarantee — applying that order directly
failed on fix sets that were perfectly valid.

**Atomicity.** The whole SQL fix set runs in one transaction. PostgreSQL
supports transactional DDL, so if any statement fails the rest are rolled back
and the target is left exactly as it was — never in a state matching neither
the source nor its own previous self. Those fixes are reported under
`Rolled back`, distinct from `Applied`, so it is always clear what is actually
in the target.

```bash
supaforge diff --dry-run                # print the plan, in execution order, and stop
supaforge diff --apply                  # all-or-nothing
supaforge diff --apply --no-transaction # statement at a time, keeping partial progress
```

`--continue-on-error` is an alias for `--no-transaction`.

`--dry-run` does not need `--apply` — previewing should not require typing the
flag that writes — and the flags that shape the plan (`--only`,
`--allow-destructive`, `--apply-posture`) apply under it. The ones that only
matter while executing (`--prove`, `--no-transaction`) warn on stderr that they
had no effect, rather than being silently ignored.

**Proof.** A migration that executes without error can still leave the target
looking nothing like the source — a partitioned table rebuilt as an ordinary
one, an index that never reached its partitions. The SQL is valid, so no amount
of reading it catches that. `--prove` replays the fix set on a throwaway clone
of the target and compares the result against the source, refusing to apply if
they differ:

```bash
supaforge diff --apply --prove
```

The clone holds structure only, is made on the target's own server, and is
dropped even if the proof throws. A failed proof exits 1 having applied nothing.
A proof that *cannot run* — no `pg_dump`, or no `CREATEDB` — is reported as not
proven and the apply continues, because being unable to check is not the same as
checking and failing; a clone that can be made but whose structure will not
replay is neither, and blocks the apply. See
[Proving a migration before you run it](packages/cli/README.md#proving-a-migration-before-you-run-it).

**Posture.** Two checks judge the target on its own rather than comparing it to
the source, so their fixes would *introduce* drift. `--apply` skips them and
says so; `--apply-posture` applies them anyway. See
[Drift score vs posture score](#drift-score-vs-posture-score).

**Scope.** With `--tables` active, a fix that depends on a table the filter
excluded is skipped with a reason naming that table, rather than attempted and
failed:

```
○ [schema] schema-create-view-2: Depends on table 'orders', excluded by --tables
```

That matters because `--tables` reaches `@dbdiff/cli`, whose own `--tables`
covers *tables* — so a narrowed fix set still arrives carrying the views,
triggers and indexes hanging off the tables it excluded.

To promote objects rather than tables, use `--only`, which takes the issue ids
`--json` already reports. It composes with a review step: diff, read the JSON,
approve a subset, apply exactly that subset.

```bash
supaforge diff --check=schema --json > plan.json
supaforge diff --apply --only=schema-create-function-7,schema-create-trigger-6
supaforge diff --apply --only='schema-create-*'      # globs allowed
```

## MCP Integration (AI Agents)

SupaForge ships a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server. Configure Claude Desktop, Cursor, or any MCP-compatible AI client to call SupaForge tools directly:

```json
{
  "mcpServers": {
    "supaforge": {
      "command": "supaforge",
      "args": ["mcp"]
    }
  }
}
```

The MCP server exposes:

| Tool | Description |
|------|-------------|
| `scan_drift` | Scan for drift and return a structured report |
| `apply_fixes` | Apply SQL fixes (supports `dryRun=true` preview) |
| `take_snapshot` | Capture a point-in-time environment snapshot |
| `create_migration` | Generate a migration file from snapshot diff |
| `get_check_result` | Retrieve the result for a specific check from the last scan |

Resources: `supaforge://config`, `supaforge://last-scan`, `supaforge://migrations`

Prompts: `review_drift_before_deploy`, `fix_critical_issues`

## Configuration

Create `supaforge.config.json` in your project root:

```json
{
  "environments": {
    "dev": {
      "dbUrl": "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres",
      "projectRef": "abc123",
      "accessToken": "your-service-role-key"
    },
    "prod": {
      "dbUrl": "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres",
      "projectRef": "xyz789",
      "accessToken": "your-service-role-key"
    }
  },
  "source": "dev",
  "target": "prod",
  "ignoreSchemas": ["auth", "storage", "realtime", "vault"],
  "checks": {
    "data": {
      "tables": ["plans", "feature_flags", "pricing_tiers"]
    },
    "exclude": ["storage", "vault", "auth", "edge-functions", "realtime"]
  }
}
```

Supabase internal schemas (`auth`, `storage`, `realtime`, `vault`, etc.) are ignored by default.

`checks.migrations.mode` controls how Layer 13 reports local migration files
with no row in `supabase_migrations.schema_migrations`. That table is a Supabase
CLI convention, not a database requirement, so projects applying migrations via
`psql` or the SQL editor never populate it:

| Mode | Behaviour |
| --- | --- |
| `auto` *(default)* | Tracking table empty but local files exist → one INFO noting an untracked migration workflow, instead of a warning per file. Otherwise warn per file. |
| `warn` | Always warn per unrecorded file. |
| `ignore` | Report nothing from this check at all. |

```json
{ "checks": { "migrations": { "mode": "ignore" } } }
```

The collapse only applies when *nothing* is tracked — a project that recorded
some migrations and missed others has genuine drift and still gets one warning
per missing file. To adopt the tracking table instead, `supaforge migrate
baseline` records existing files as applied without executing them.

### Per-environment check config

A check can be fine against a fast local clone and hopeless against a remote
environment over a VPN, so `checks` can also be set per environment. These apply
when that environment is the **target** — the side every check reads from — and
are unioned with the top-level `checks.exclude` rather than replacing it:

```json
{
  "environments": {
    "local":      { "dbUrl": "$LOCAL_DATABASE_URL" },
    "production": {
      "dbUrl": "$PRODUCTION_DATABASE_URL",
      "checks": {
        "exclude": ["storage"],
        "schema": { "timeout": 900 }
      }
    }
  }
}
```

| Field | Description |
| --- | --- |
| `checks.exclude` | Checks to skip when this environment is the target. |
| `checks.schema.timeout` | Seconds before the schema/data diff is abandoned, for this environment. |

Timeout precedence is `SUPAFORGE_DBDIFF_TIMEOUT` → `checks.schema.timeout` →
the 600s default, so the environment variable stays a runtime escape hatch that
beats a committed value.

The MCP server accepts a `skip` argument on `scan_drift` for the same reason —
an agent can avoid a slow layer without editing the project config.

### Drift score vs posture score

RLS Coverage and Migration History are not source↔target comparisons — they
report on the target alone and fire identically whichever pair you diff. They
are scored separately as a **posture score**, so a genuinely synchronised pair
reaches `Drift score: 100/100` even when it carries pre-existing findings on
both sides. The findings keep their severity and are reported in full.

They do not decide the exit code either, for the same reason: a pre-existing RLS
gap is true of the target whichever pair you diff, so letting it exit 1 meant a
perfectly synchronised pair failed a sync check forever. Add `--fail-on-posture`
to gate on them as well.

Their *fixes* are also held back by `--apply`, for the same reason they are
scored apart: enabling RLS on a target whose source has it disabled moves the
target away from the source, so the next diff reports schema drift and the next
sync undoes it. Each one is reported as skipped with that reason, and
`--apply-posture` applies them anyway when the posture is what you are actually
fixing:

```
○ [rls-coverage] rls-coverage-public.customers: Posture finding about the target,
  not drift from the source — applying it would create drift.
  Use --apply-posture to apply anyway.
```

Naming the check explicitly (`--check=rls-coverage --apply`) counts as asking,
so a deliberate RLS rollout does not need the extra flag.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Did what was asked — including when there was nothing to do |
| `1` | Ran, but declined to act, found drift above the threshold, or an operation failed |
| `2` | Could not run: a usage error, or (in `--ci`) a check that could not complete |

A command that refuses to act is not a success, so `restore … --apply &&
./deploy.sh` will not deploy when the restore declined. `--ci` gives `diff`,
`sync` and `hukam` a stricter contract with the threshold under your control —
`--fail-on=critical` (the default), `warning`, or `any` — and turns a check that
could not complete into exit `2`, because unmeasured is not the same as clean.

The threshold applies to the twelve checks that compare the two environments.
RLS Coverage and Migration History describe the target alone, so they are
reported in full but do not set the exit code unless `--fail-on-posture` asks
them to — otherwise a pre-existing RLS gap would fail a sync check against an
identical target, forever.

### Scoping a diff to specific tables

`--check` / `--skip` select whole layers; `--tables` / `--exclude-tables` scope
within the schema and data layers, so a reviewed subset can be promoted rather
than applying everything a layer found.

```bash
supaforge diff --tables=orders,order_items
supaforge diff --tables='billing_*' --exclude-tables='*_audit'
supaforge diff --tables=orders --apply
```

With `--apply`, a fix depending on an excluded table is skipped and says so —
see [How `--apply` executes](#how---apply-executes). `--only` selects
individual issues by id, which is how to scope to non-table objects such as
functions and views.

Both are repeatable, comma-separated, and support `@dbdiff/cli` globs. The
config equivalents are `checks.tables` and `checks.excludeTables`; `--tables`
overrides the former, `--exclude-tables` is unioned with the latter. A scoped
run prints what it is scoped to before it starts.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPAFORGE_DBDIFF_TIMEOUT` | `600` | Seconds before the schema/data diff is abandoned. Overrides `checks.schema.timeout`. |
| `SUPAFORGE_DBDIFF_MEMORY` | dbdiff's own `1G` | Passed to `@dbdiff/cli --memory-limit`. Takes `512M`, `2G`, or `-1` for unlimited. |
| `SUPAFORGE_CONNECT_TIMEOUT` | `15` | Seconds before a database connection attempt is abandoned. Applies to every connection, including the preflight reachability check. |

```bash
SUPAFORGE_DBDIFF_TIMEOUT=600 SUPAFORGE_DBDIFF_MEMORY=2G supaforge diff
```

`checks.exclude` permanently skips the listed checks on every `diff`/`hukam`/`sync` run — useful when diffing against a clone, where `storage`, `auth`, `edge-functions`, `vault`, `realtime` and `roles` have no local equivalent and produce only noise. Roles is easy to overlook and is the second-largest source of it: a clone is vanilla PostgreSQL, so Supabase's service roles do not exist and every grant referencing one reads as drift. The `--skip` CLI flag does the same on a one-off basis; both are merged at runtime.

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
│   ├── commands/        # init, diff, sync, hukam, snapshot, clone, restore,
│   │                    #   migrate/, report, mcp
│   ├── checks/          # The 14 drift checks
│   │   ├── base.ts      # Abstract Check class
│   │   ├── registry.ts  # CheckRegistry
│   │   ├── rls.ts       # RLS policy diffing
│   │   ├── cron.ts      # Cron job diffing
│   │   └── ...          # schema, data, rls-coverage, edge-functions, storage,
│   │                    #   auth, webhooks, realtime, vault, extensions,
│   │                    #   migrations, roles
│   ├── types/           # TypeScript interfaces
│   ├── utils/           # Shared utilities (error handling)
│   ├── constants.ts     # Centralised config values, timeouts, paths
│   ├── config.ts        # Config loader + validator
│   ├── hooks.ts         # HookBus (actions + filters)
│   ├── scanner.ts       # Scan orchestrator
│   ├── promote.ts       # Apply decisions: order, atomicity, scope, posture
│   ├── prove.ts         # Replay a fix set on a throwaway clone
│   ├── scoring.ts       # Drift and posture scores (0–100)
│   └── render.ts        # Terminal output
└── test/                # 1311 tests across 62 files
```

## Development

```bash
git clone https://github.com/akalforge/supaforge.git
cd supaforge/packages/cli
npm install
npm test       # Run all tests (1311 across 62 files)
npm run lint   # Type-check
npm run build  # Build with tsup

# Run in dev mode
./bin/dev.js diff
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
