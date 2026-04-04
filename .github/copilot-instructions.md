# SupaForge — Project Guidelines

## What This Is

Supabase environment drift detection and sync CLI. Scans 8 layers (schema, RLS policies, Edge Functions, storage, auth config, cron jobs, reference data, webhooks) and generates SQL fixes to promote changes between environments.

**Motivation**: CVE-2025-48757 exposed 170+ Lovable-generated apps with missing RLS policies never promoted to production.

## Architecture

```
packages/cli/src/
  commands/     — oclif commands: scan, diff, promote, hukam
  layers/       — Layer implementations (base, schema, rls, edge-functions, storage, auth, cron, data, webhooks)
                  + registry.ts (LayerRegistry), index.ts (factory)
  types/        — config.ts, drift.ts, index.ts
  config.ts     — Config loading/validation
  db.ts         — PostgreSQL query helper (pg driver)
  dbdiff.ts     — @dbdiff/cli spawner + output parser
  scanner.ts    — Main scan orchestrator
  promote.ts    — Execute SQL fixes in target DB
  hooks.ts      — HookBus event system
  render.ts     — Output formatting
  scoring.ts    — Score calculation from layer results
  defaults.ts   — DEFAULT_IGNORE_SCHEMAS
```

**Key flow**: `scan` command → load config → create layer registry → `scanner.scan()` iterates layers → each `layer.scan(ctx)` returns `DriftIssue[]` → scoring → render output.

**Patterns**: Layer (abstract base + concrete implementations), Registry (LayerRegistry), Strategy (each layer is a strategy), Hook Bus (event-driven pipeline).

**DBDiff integration**: Schema/data layers invoke `@dbdiff/cli diff` via local binary resolution in `dbdiff.ts`. `@dbdiff/cli` is a direct dependency. The adapter writes to a temp file (`--output`), reads it back, and parses UP/DOWN markers. When schemas are identical dbdiff doesn't create the output file — the adapter handles this gracefully.

## Build & Test

```bash
cd packages/cli
npm install
npm run build                          # tsup → dist/
npm run dev                            # Development mode (tsx)
npm run lint                           # TypeScript type-check only
npm test                               # Vitest unit tests
npm run test:watch                     # Unit tests in watch mode
npm run test:integration               # Docker-based integration tests
npm run test:e2e                       # E2E tests
```

**Build**: tsup, ESM-only, targets Node 18+, 5 entry points (index + 4 commands).

**Test structure**: `test/` for unit tests, `tests/integration/` for integration tests, `test/e2e/` for E2E.

## Conventions

- **TypeScript strict mode**, ESM-only (no CommonJS).
- **oclif** for command structure — each command extends `Command`.
- **Layer pattern**: All layers extend abstract `Layer` class with `name` and `scan(ctx)`.
- **Dependency injection**: Layers accept `queryFn`/`fetchFn` for testability.
- **Config file**: `supaforge.config.json` in working directory.

## Key Gotchas

- `@dbdiff/cli` is a direct dependency — `dbdiff.ts` resolves the local binary via `createRequire`, falls back to `npx` if not found.
- `dbdiff.ts` parses UP/DOWN SQL from markers: `#---------- UP ----------` / `#---------- DOWN ----------`.
- Integration tests are sequential (`fileParallelism: false`) with 30s timeout.
- `defaults.ts` defines `DEFAULT_IGNORE_SCHEMAS` (auth, storage, etc.) — checked by all DB-querying layers.

## Docs

- [README.md](../README.md) — Overview, motivation, usage
- [docs/spec.md](../docs/spec.md) — Full specification, layer details, architecture

## Definition of Done

Every branch or piece of independent work MUST satisfy all of the following before it is considered complete:

- **Minimal dependencies**: Make the simplest fix or feature possible. Do NOT add external production dependencies unless unavoidable. Dev dependencies are fine only if: actively maintained open source, MIT or Apache 2.0 license, regular releases, and many contributors.
- **DRY code**: Don't Repeat Yourself. Before implementing any functionality, check existing utils, helpers, and config in the codebase. Extract repeated logic into shared utilities or base classes.
- **No magic values**: Key config, numbers, and settings must not be hardcoded in source files. Extract them to named constants or config (e.g. `defaults.ts`).
- **Low complexity**: No single file should carry too much responsibility. Extract reusable classes and utilities with their own dedicated unit tests.
- **Tests**: Add or update unit tests AND e2e tests. Register unit tests in `.github/workflows/ci.yml` and integration tests in `.github/workflows/integration.yml` so they run in CI.
- **Local verification**: Run all relevant unit and e2e tests locally via Podman (or Docker if installed) and confirm they pass before treating the work as done.
- **Docs updated**: Update `README.md`, `docs/spec.md`, and inline JSDoc to reflect the change. Include a usage example for any user-facing change. Do NOT create new documentation files unless explicitly instructed to do so.
- **Clean commits**: Never force-add files or folders excluded by `.gitignore`. Do not mention gitignored paths or any part of their file contents in commit messages or PR descriptions.
