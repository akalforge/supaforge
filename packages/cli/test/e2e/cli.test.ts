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

describe('CLI e2e: scan', () => {
  it('should show help', async () => {
    const { stdout } = await run(['scan', '--help'])
    expect(stdout).toContain('Scan all checks')
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['scan'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('should reject invalid --check value', async () => {
    try {
      await run(['scan', '--check=bogus'])
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/Expected.*bogus|must be one of/i)
    }
  })
})

describe('CLI e2e: promote', () => {
  it('should show help', async () => {
    const { stdout } = await run(['promote', '--help'])
    expect(stdout).toContain('Apply SQL fixes')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--check')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-promote-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['promote'], { cwd: tmpDir })
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
      await run(['scan'], { cwd: configDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toContain('Source and target must be different')
    }
  })
})
