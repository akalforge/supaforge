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

  it('should show --source and --target flags in help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
    expect(stdout).toContain('--include-files')
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
