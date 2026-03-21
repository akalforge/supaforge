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
- **Injectable dependencies** — layers accept `QueryFn`/`FetchFn` for testability
- **No external state** — pure functions where possible

## Testing Guidelines

- Tests live in `test/` mirroring `src/` structure
- Use **vitest** with the standard `describe`/`it`/`expect` API
- Layer tests should use injectable stubs — no real database connections
- Aim for isolated, fast, deterministic tests

## Commit Message Guidelines

Use clear, imperative commit messages:

```
fix: handle pg_cron not installed in cron layer
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
│   ├── commands/    # oclif CLI commands
│   ├── layers/      # 8 drift detection layers
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
