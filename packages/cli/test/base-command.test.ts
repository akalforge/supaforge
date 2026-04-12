/**
 * Unit tests for BaseCommand — shared config loading, env resolution,
 * dual-env validation, and URL redaction used by all commands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BaseCommand } from '../src/base-command.js'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SupaForgeConfig } from '../src/types/config.js'

/* ── Concrete test subclass (BaseCommand is abstract) ─────────────── */

class TestCommand extends BaseCommand {
  static override id = 'test'
  static override description = 'Test command'

  // Expose protected methods for testing
  public exposedLoadConfigOrFail = () => this.loadConfigOrFail()
  public exposedResolveEnv = (
    config: SupaForgeConfig,
    envFlag?: string,
  ) => this.resolveEnv(config, envFlag)
  public exposedValidateDualEnvConfig = (
    config: SupaForgeConfig,
    source?: string,
    target?: string,
  ) => this.validateDualEnvConfig(config, source, target)
  public exposedRedactUrl = (url: string) => this.redactUrl(url)

  async run() {
    // noop
  }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function makeConfig(overrides: Partial<SupaForgeConfig> = {}): SupaForgeConfig {
  return {
    environments: {
      dev: { dbUrl: 'postgres://u:pass@dev.host/db' },
      prod: { dbUrl: 'postgres://u:pass@prod.host/db' },
    },
    source: 'dev',
    target: 'prod',
    ...overrides,
  }
}

/* ── Tests ────────────────────────────────────────────────────────── */

describe('BaseCommand', () => {
  let cmd: TestCommand

  beforeEach(() => {
    cmd = new TestCommand([], {} as any)
    // Suppress error from calling this.exit — oclif throws
    vi.spyOn(cmd, 'error').mockImplementation((msg) => {
      throw new Error(typeof msg === 'string' ? msg : msg.message)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── redactUrl ──────────────────────────────────────────────────

  describe('redactUrl', () => {
    it('should mask password between : and @', () => {
      expect(cmd.exposedRedactUrl('postgres://user:secret@host/db'))
        .toBe('postgres://user:***@host/db')
    })

    it('should handle URL-encoded special chars in password', () => {
      expect(cmd.exposedRedactUrl('postgres://user:p%40ss%23@host/db'))
        .toBe('postgres://user:***@host/db')
    })

    it('should leave URL unchanged if no password', () => {
      const url = 'postgres://host/db'
      expect(cmd.exposedRedactUrl(url)).toBe(url)
    })

    it('should not redact empty password (no secret to hide)', () => {
      expect(cmd.exposedRedactUrl('postgres://user:@host/db'))
        .toBe('postgres://user:@host/db')
    })
  })

  // ── resolveEnv ─────────────────────────────────────────────────

  describe('resolveEnv', () => {
    it('should return env by explicit flag', () => {
      const config = makeConfig()
      const { envName, env } = cmd.exposedResolveEnv(config, 'prod')
      expect(envName).toBe('prod')
      expect(env.dbUrl).toContain('prod.host')
    })

    it('should fall back to config.source when no flag', () => {
      const config = makeConfig()
      const { envName } = cmd.exposedResolveEnv(config)
      expect(envName).toBe('dev')
    })

    it('should error when env not found in config', () => {
      const config = makeConfig()
      expect(() => cmd.exposedResolveEnv(config, 'staging')).toThrow()
    })

    it('should error when no env specified and no source set', () => {
      const config = makeConfig({ source: undefined })
      expect(() => cmd.exposedResolveEnv(config)).toThrow('No environment specified')
    })
  })

  // ── validateDualEnvConfig ──────────────────────────────────────

  describe('validateDualEnvConfig', () => {
    it('should pass with valid source + target', () => {
      const config = makeConfig()
      expect(() => cmd.exposedValidateDualEnvConfig(config)).not.toThrow()
    })

    it('should error when source equals target', () => {
      const config = makeConfig({ source: 'dev', target: 'dev' })
      expect(() => cmd.exposedValidateDualEnvConfig(config)).toThrow()
    })

    it('should apply flag overrides before validation', () => {
      const config = makeConfig({ source: undefined, target: undefined })
      expect(() =>
        cmd.exposedValidateDualEnvConfig(config, 'dev', 'prod'),
      ).not.toThrow()
    })

    it('should error when source env is missing from environments', () => {
      const config = makeConfig({ source: 'staging' })
      expect(() => cmd.exposedValidateDualEnvConfig(config)).toThrow()
    })
  })
})
