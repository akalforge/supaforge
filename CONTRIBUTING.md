# Contributing to SupaForge

Thank you for your interest in contributing! This guide will help you get started.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally
3. **Create a branch** for your changes
4. **Make your changes** and commit them
5. **Push** to your fork and submit a pull request

## Development Setup

```bash
git clone https://github.com/<your-username>/supaforge.git
cd supaforge/packages/cli
npm install
```

### Common Commands

```bash
npm test        # Run tests (vitest)
npm run lint    # Type-check (tsc --noEmit)
npm run build   # Production build (tsup)
./bin/dev.js scan   # Run in dev mode
```

## How to Contribute

### Reporting Bugs

Before opening a bug report, check existing issues to avoid duplicates. Include:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs actual behaviour
- Your environment (OS, Node.js version, SupaForge version)

### Suggesting Features

Open an issue with the **feature request** template. Describe the use case and how the feature would work.

### Submitting Code

1. Open an issue first to discuss the change
2. Write tests for any new functionality
3. Ensure all tests pass: `npm test`
4. Ensure type-checking passes: `npm run lint`
5. Follow the existing code style

## Coding Standards

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **ESM only** — no CommonJS requires
- **Extensionless imports** — do not add `.js` to import paths (tsup/Bundler handles resolution)
- **Injectable dependencies** — checks accept `QueryFn`/`FetchFn` for testability
- **No external state** — pure functions where possible

## Testing Guidelines

- Tests live in `test/` mirroring `src/` structure
- Use **vitest** with the standard `describe`/`it`/`expect` API
- Check tests should use injectable stubs — no real database connections
- Aim for isolated, fast, deterministic tests

### End-to-end tests against real databases

`test/e2e/lifecycle.test.ts` runs the real CLI against a pair of throwaway
PostgreSQL instances via `test/harness/PgHarness.ts`, and asserts the target
ends up structurally identical to the source. It skips itself when no container
runtime is available, so `npm test` still passes without Podman or Docker.

`PgHarness.assertLocal()` refuses any non-loopback connection string. The
harness is destructive by design, so this is what stops a mistyped config
pointing it at a real project.

### Testing against a DBDiff source checkout

SupaForge delegates schema comparison to [`@dbdiff/cli`](https://github.com/DBDiff/DBDiff).
When a diff is wrong, the cause is usually in DBDiff — but confirming that
normally means publishing a release, which is a slow way to test a one-line fix.

`scripts/test-against-dbdiff-source.sh` runs the whole stack against a **local
DBDiff checkout** instead, so a fix can be validated through SupaForge before
anything is released.

```bash
# defaults to a sibling DBDiff checkout
./scripts/test-against-dbdiff-source.sh

# explicit checkout, and your own SQL corpus
./scripts/test-against-dbdiff-source.sh --dbdiff ~/src/DBDiff --sql ./fixtures/

# leave the databases up to poke at them
./scripts/test-against-dbdiff-source.sh --keep
```

Requirements: a container runtime (Podman preferred, Docker works) and
`composer install` having been run in the DBDiff checkout. **PHP and
PostgreSQL are not needed on the host** — both run inside the image the script
builds.

### How it substitutes DBDiff

`@dbdiff/cli` is a thin Node launcher around a PHP program. It prefers a
pre-built native binary from a platform package, and falls back to a bundled
`dbdiff.phar` executed with system PHP:

```
bin/dbdiff.js
  ├─ @dbdiff/cli-linux-x64/dbdiff   ← native binary, used when present
  └─ dbdiff.phar + php              ← fallback
```

The script moves the native binary aside and replaces the phar with a one-line
shim into the source checkout:

```php
<?php require "/dbdiff/dbdiff.php";
```

`dbdiff.php` resolves its own autoloader relative to `__DIR__`, so that single
line is enough to run the working tree. Nothing is published, no `npm link` is
involved, and `node_modules` is restored by an `EXIT` trap — including when the
run fails or is interrupted.

> The restore is deliberately defensive. It runs from a trap under `set -e`,
> where one non-zero test would otherwise abandon the rest of the cleanup and
> leave `node_modules` patched.

### What it asserts

The script builds a schema in the source database, runs a real
`supaforge sync --apply` against an empty target, then compares a **structural
fingerprint** of both databases — columns, constraints, indexes, and each
relation's `relkind` and partition bound.

That last part matters. Comparing generated SQL text only tells you the output
is stable, not that it is *correct*: a migration can run perfectly and still
produce a different database. Partitioned tables were silently rebuilt as
ordinary tables for exactly this reason — every statement succeeded, so no
text-based assertion could have caught it.

Exit status is 0 only on an exact structural match, so this is safe to run in CI.

### Fixtures

By default it loads the stage ladder from `test/harness/stages.ts` — tables,
foreign keys and awkward column types, functions and triggers, partial and
expression and GIN indexes, views, RLS policies, extra schemas and grants.

`--sql DIR` loads every `.sql` file in a directory instead. A good external
corpus is `nix/tests/sql/docs-*.sql` from
[supabase/postgres](https://github.com/supabase/postgres) (PostgreSQL licence —
permissive, commercial use fine, keep the copyright notice). Those files are
plain DDL taken from the Supabase docs and cover enums, partitioning, triggers,
generated columns, full-text search and cascading deletes.

They are written as regression tests, so most end by dropping what they create.
Strip the teardown to use them as a fixture:

```bash
mkdir -p /tmp/corpus
for f in nix/tests/sql/docs-*.sql; do
  grep -viE '^\s*drop\s+(table|function|type|view|index|trigger|schema)' "$f" \
    > "/tmp/corpus/$(basename "$f")"
done
./scripts/test-against-dbdiff-source.sh --sql /tmp/corpus
```

Some of that corpus expects Supabase's roles (`authenticated`, `anon`,
`service_role`); the script creates them up front, and skips any file that
fails to load rather than aborting the run.

### What this found

Running the Supabase corpus through this harness surfaced four defects in
DBDiff's PostgreSQL adapter, none of which any existing test could catch,
because DBDiff's suite compares generated SQL to recorded `expected/` files and
never replays it:

| Symptom | Cause |
|---|---|
| `multiple primary keys for table "t" are not allowed` | the primary key was emitted bare *and* as a named constraint |
| `relation "t_id_seq" does not exist` | `serial` written back as a raw `nextval()` default, with no sequence |
| `syntax error at or near "USER"` | enums emitted as the literal `USER-DEFINED` placeholder |
| no error at all | partitioned tables silently rebuilt as ordinary tables |

The first three broke the migration outright. The fourth is the one worth
remembering: it produced valid SQL that ran cleanly and quietly changed the
data model.

### Ports

Ports are requested from the OS at start-up rather than hardcoded, so parallel
runs don't collide and nothing binds to a predictable value. The databases are
reachable only over loopback and are removed when the run ends.

## Commit Message Guidelines

Use clear, imperative commit messages:

```
fix: handle pg_cron not installed in cron check
feat: add --json flag to diff command
test: add scoring edge-case tests
docs: update README with hook examples
```

## Pull Request Process

1. Fill out the PR template completely
2. Ensure CI passes (lint, test, build)
3. Keep PRs focused — one concern per PR
4. Be responsive to review feedback

## Project Structure

```
packages/cli/
├── src/
│   ├── commands/    # CLI commands
│   ├── checks/      # Drift detection checks
│   ├── types/       # TypeScript interfaces
│   ├── config.ts    # Config loader
│   ├── hooks.ts     # HookBus
│   ├── scanner.ts   # Scan orchestrator
│   ├── scoring.ts   # Health score
│   └── render.ts    # Terminal output
└── test/            # Test suites
```

## Questions?

Open a [discussion](https://github.com/akalforge/supaforge/discussions) or file an issue. We're happy to help.
