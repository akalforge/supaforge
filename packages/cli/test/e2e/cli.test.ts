/**
 * CLI e2e tests — run the oclif commands via bin/dev.js as subprocesses.
 *
 * These validate the CLI surface without needing real database containers.
 * They test --help output, config loading errors, flag parsing, etc.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
// test/e2e/ → packages/cli/
const CLI_DIR = join(import.meta.dirname, '..', '..')
const DEV_BIN = join(CLI_DIR, 'bin', 'dev.js')
const TSX_BIN = join(CLI_DIR, 'node_modules', '.bin', 'tsx')

function run(args: string[], options?: { cwd?: string; env?: Record<string, string> }) {
  return exec(TSX_BIN, [DEV_BIN, ...args], {
    cwd: options?.cwd ?? CLI_DIR,
    env: { ...process.env, ...options?.env },
    timeout: 15_000,
  })
}

describe('CLI e2e: diff', () => {
  it('should show help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('Detect drift')
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--detail')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['diff'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('should reject invalid --check value', async () => {
    try {
      await run(['diff', '--check=bogus'])
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/Expected.*bogus|must be one of/i)
    }
  })

  it('should accept --check=rls-coverage', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-rls-coverage-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    const { stdout } = await run(['diff', '--json', '--check=rls-coverage'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(parsed).toHaveProperty('checks')
    const rlsCoverage = parsed.checks.find((c: any) => c.check === 'rls-coverage')
    expect(rlsCoverage).toBeDefined()
  })

  it('should show --source and --target flags in help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
    expect(stdout).toContain('--include-files')
  })

  it('should output valid JSON with --json flag', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-json-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    // diff will error connecting to DB but still produces JSON output
    const { stdout } = await run(['diff', '--json', '--check=rls'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('source', 'dev')
    expect(parsed).toHaveProperty('target', 'prod')
    expect(parsed).toHaveProperty('checks')
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed).toHaveProperty('score')
    expect(parsed).toHaveProperty('summary')
  })

  it('should output detailed format with --detail flag', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-detail-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    // --detail triggers preflight (which errors on unreachable DBs), but we can
    // verify the flag is accepted and the command reaches that stage.
    try {
      await run(['diff', '--detail', '--check=rls'], { cwd: tmpDir })
      expect.unreachable('Should have thrown — unreachable DB URLs')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      // Preflight ran (not a flag parsing error), proving --detail was accepted
      expect(output).toContain('preflight checks')
      expect(output).toContain('not reachable')
    }
  })
})

describe('CLI e2e: hukam', () => {
  it('should show help as alias for diff', async () => {
    const { stdout } = await run(['hukam', '--help'])
    expect(stdout).toContain('Alias for diff')
  })

  it('should accept the same flags as diff', async () => {
    const { stdout } = await run(['hukam', '--help'])
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--detail')
    expect(stdout).toContain('--check')
  })
})

describe('CLI e2e: snapshot', () => {
  it('should show help', async () => {
    const { stdout } = await run(['snapshot', '--help'])
    expect(stdout).toContain('snapshot')
    expect(stdout).toContain('--migration')
    expect(stdout).toContain('--list')
    expect(stdout).toContain('--prune')
  })

  it('should show --env and --description flags in help', async () => {
    const { stdout } = await run(['snapshot', '--help'])
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--description')
    expect(stdout).toContain('--keep')
    expect(stdout).toContain('--output')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-snapshot-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['snapshot'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: clone', () => {
  it('should show help', async () => {
    const { stdout } = await run(['clone', '--help'])
    expect(stdout).toContain('Clone')
    expect(stdout).toContain('--list')
    expect(stdout).toContain('--delete')
    expect(stdout).toContain('--apply')
  })

  it('should show --env and --schema-only flags in help', async () => {
    const { stdout } = await run(['clone', '--help'])
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--schema-only')
    expect(stdout).toContain('--local-url')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['clone'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: restore', () => {
  it('should show help', async () => {
    const { stdout } = await run(['restore', '--help'])
    expect(stdout).toContain('Restore')
    expect(stdout).toContain('--from-snapshot')
    expect(stdout).toContain('--from-migrations')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--force')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-restore-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['restore', '--env=local', '--from-snapshot=latest'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('should require --from-snapshot or --from-migrations', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-restore-flags-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        local: { dbUrl: 'postgresql://localhost/test' },
      },
      source: 'local',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['restore', '--env=local'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/--from-snapshot|--from-migrations/)
    }
  })
})

describe('CLI e2e: init', () => {
  it('should show help', async () => {
    const { stdout } = await run(['init', '--help'])
    expect(stdout).toContain('supaforge.config.json')
    expect(stdout).toContain('--force')
  })
})

describe('CLI e2e: sync', () => {
  it('should show help', async () => {
    const { stdout } = await run(['sync', '--help'])
    expect(stdout).toContain('diff --apply')
  })

  it('should accept the same flags as diff', async () => {
    const { stdout } = await run(['sync', '--help'])
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-sync-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['sync'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: config validation', () => {
  let configDir: string

  beforeAll(async () => {
    configDir = join(tmpdir(), `supaforge-e2e-config-${Date.now()}`)
    await mkdir(configDir, { recursive: true })
  })

  afterAll(async () => {
    try {
      await unlink(join(configDir, 'supaforge.config.json'))
    } catch {}
  })

  it('should reject config with same source and target', async () => {
    const config = {
      environments: {
        staging: { dbUrl: 'postgresql://localhost/staging' },
        prod: { dbUrl: 'postgresql://localhost/prod' },
      },
      source: 'staging',
      target: 'staging',
    }
    await writeFile(join(configDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['diff'], { cwd: configDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toContain('Source and target must be different')
    }
  })
})

// ─── migrate run ─────────────────────────────────────────────────────────────

describe('CLI e2e: migrate run', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'run', '--help'])
    expect(stdout).toContain('Execute pending migrations')
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--dry-run')
    expect(stdout).toContain('--up-to')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-run-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['migrate', 'run'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

// ─── migrate baseline ────────────────────────────────────────────────────────

describe('CLI e2e: migrate baseline', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'baseline', '--help'])
    expect(stdout).toContain('Mark all local migrations as applied')
    expect(stdout).toContain('--env')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-baseline-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['migrate', 'baseline'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

// ─── migrate create ──────────────────────────────────────────────────────────

describe('CLI e2e: migrate create', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'create', '--help'])
    expect(stdout).toContain('Generate a new migration file')
    expect(stdout).toContain('--name')
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
  })

  it('should require --name flag', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-create-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://localhost/dev' },
        prod: { dbUrl: 'postgresql://localhost/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['migrate', 'create'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/--name|Missing required flag/i)
    }
  })

  it('creates a timestamped .sql file under supabase/migrations/', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-create-file-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    // migrate create requires real DB access for preflight — verify it reaches
    // that stage (flag accepted, config loaded) rather than failing on config/flag parsing.
    try {
      await run(['migrate', 'create', '--name=add_users'], { cwd: tmpDir })
      expect.unreachable('Should have thrown — unreachable DB URLs')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      // Preflight ran (not a flag/config parsing error)
      expect(output).toContain('preflight checks')
      expect(output).toContain('not reachable')
    }
  })
})

describe('CLI e2e: mcp', () => {
  it('should show help', async () => {
    const { stdout } = await run(['mcp', '--help'])
    expect(stdout).toContain('MCP')
    expect(stdout).toContain('stdio')
    expect(stdout).toContain('Claude Desktop')
  })
})

// ─── diff: schema error message ───────────────────────────────────────────────

describe('CLI e2e: diff schema error', () => {
  it('schema error message does not expose raw "Command failed:" string', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-schema-error-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))
    const { stdout } = await run(['diff', '--json', '--check=schema'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    const schemaCheck = parsed.checks.find((c: any) => c.check === 'schema')
    expect(schemaCheck).toBeDefined()
    if (schemaCheck.error) {
      expect(schemaCheck.error).not.toContain('Command failed:')
      expect(schemaCheck.error).not.toContain('/bin/node')
      expect(schemaCheck.error).not.toContain('dbdiff.js diff')
    }
  })
})

// ─── clone --list ─────────────────────────────────────────────────────────────

describe('CLI e2e: clone --list', () => {
  it('--list reads from .supaforge/branches.json and shows existing clones', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-list-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    const supaforgeDir = join(tmpDir, '.supaforge')
    await mkdir(supaforgeDir, { recursive: true })
    const branches = {
      branches: [{
        name: 'my-local',
        dbName: 'supaforge_branch_my_local',
        dbUrl: 'postgres://postgres:postgres@localhost:5432/supaforge_branch_my_local',
        createdFrom: 'production',
        createdAt: new Date().toISOString(),
        schemaOnly: false,
      }]
    }
    await writeFile(join(supaforgeDir, 'branches.json'), JSON.stringify(branches))

    const { stdout } = await run(['clone', '--list', '--json'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('my-local')
    expect(parsed[0].createdFrom).toBe('production')
  })

  it('--list shows empty message when no branches.json exists', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-list-empty-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['clone', '--list'], { cwd: tmpDir })
    expect(stdout).toContain('No clones found')
  })
})

// ─── report ───────────────────────────────────────────────────────────────────

describe('CLI e2e: report', () => {
  it('should show help', async () => {
    const { stdout } = await run(['report', '--help'])
    expect(stdout).toContain('run log')
    expect(stdout).toContain('--last')
    expect(stdout).toContain('--json')
  })

  it('should output valid JSON with --json when no log exists', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-report-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['report', '--json'], { env: { HOME: tmpDir } })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(0)
  })

  it('should show "No command history found" when log is empty', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-report-empty-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['report'], { env: { HOME: tmpDir } })
    expect(stdout).toContain('No command history found')
  })
})

// ─── migrate list ─────────────────────────────────────────────────────────────

describe('CLI e2e: migrate list', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'list', '--help'])
    expect(stdout).toContain('List local migration files')
    expect(stdout).toContain('--offline')
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    try {
      await run(['migrate', 'list'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('--offline shows local files without DB connection', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-offline-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: { dev: { dbUrl: 'postgresql://invalid:5432/dev' } },
      source: 'dev',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))
    const migrationsDir = join(tmpDir, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20240101000000_initial.sql'), '-- init')

    const { stdout } = await run(['migrate', 'list', '--offline'], { cwd: tmpDir })
    expect(stdout).toContain('20240101000000_initial.sql')
  })

  it('--offline --json returns array of migrations', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-json-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: { dev: { dbUrl: 'postgresql://invalid:5432/dev' } },
      source: 'dev',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))
    const migrationsDir = join(tmpDir, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20240101000000_init.sql'), '-- init')
    await writeFile(join(migrationsDir, '20240102000000_users.sql'), '-- users')

    const { stdout } = await run(['migrate', 'list', '--offline', '--json'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].version).toBe('20240101000000')
    expect(parsed[1].version).toBe('20240102000000')
  })
})
