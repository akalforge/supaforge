# SupaForge

> Diff and sync your Supabase environments.

[![CI](https://github.com/akalforge/supaforge/actions/workflows/ci.yml/badge.svg)](https://github.com/akalforge/supaforge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@akalforge/supaforge.svg)](https://www.npmjs.com/package/@akalforge/supaforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Supabase projects running as dev, staging and production drift apart, and
nothing in Supabase tells you. SupaForge compares two of them across 14
checks, from schema, RLS and storage to cron, webhooks, Realtime, Vault and
grants. It reports what differs and fixes the target, safely. With one
project, it snapshots, clones and restores it.

**CVE-2025-48757** found 170+ apps with exposed databases because RLS policies
never reached production. SupaForge catches that on the first scan.

Built by **[Akal](https://github.com/akalforge)**.

## Quick start

```bash
npm install -g @akalforge/supaforge

supaforge init              # create supaforge.config.json
supaforge diff              # what has drifted?
supaforge diff --detail     # with the SQL
supaforge diff --apply      # fix the target
```

Only one project?

```bash
supaforge snapshot --env=prod --apply                       # record it
supaforge restore --env=local --from-snapshot=latest --apply
supaforge clone --env=prod --apply                          # local copy, data included
```

Everything that writes previews first. Add `--apply` to make it happen. Fixes
that drop or delete need `--allow-destructive` too, and a whole apply rolls
back if any part of it fails.

**[Full documentation →](packages/cli/README.md)**: the checks, commands,
safety model, snapshots and restore, migrations, configuration, self-hosted
Supabase, CI and MCP.

## Repository

| Path | What |
| --- | --- |
| [`packages/cli`](packages/cli) | The `supaforge` CLI and library, published as [`@akalforge/supaforge`](https://www.npmjs.com/package/@akalforge/supaforge) |
| [`packages/mcp`](packages/mcp) | A standalone build of the MCP server, not published. Use `supaforge mcp` |

The schema and data checks run [`@dbdiff/cli`](https://github.com/DBDiff/DBDiff),
installed as a dependency, with no PHP needed.

## Development

```bash
git clone https://github.com/akalforge/supaforge.git
cd supaforge/packages/cli
npm install
npm test && npm run lint
./bin/dev.js diff
```

The integration, database e2e, scenario and Supabase e2e suites are described
in the [package README](packages/cli/README.md#development). CI runs all of
them on every pull request.

### Releasing

Run the **Trigger Release** workflow (Actions → Trigger Release) with `patch`,
`minor`, `major` or an exact version. It bumps the version, tags it, and
publishes to npm and GitHub Packages.

`node scripts/release.js patch` does the same steps locally, as a dry run
unless given `--apply`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Akal Software Ltd
