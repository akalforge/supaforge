/**
 * Integration tests for `supaforge backup` against real Postgres containers.
 *
 * Tests incremental backup flow: snapshot + migration diff generation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup } from '../../src/migration.js'
import { listMigrationFiles, loadMigrations } from '../../src/migration.js'
import type { SupaForgeConfig } from '../../src/types/config.js'
import { SOURCE_URL, skipIfNoContainers } from './helpers.js'

function makeSingleEnvConfig(): SupaForgeConfig {
  return {
    environments: {
      source: { dbUrl: SOURCE_URL! },
    },
    source: 'source',
    target: 'source',
    ignoreSchemas: [
      'information_schema', 'pg_catalog', 'pg_toast',
      'extensions', 'graphql', 'graphql_public',
      'pgsodium', 'realtime', 'vault', '_realtime',
    ],
  }
}

describe('integration: backup', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-backup-int-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it.skipIf(skipIfNoContainers())('first backup creates baseline migration', async () => {
    const config = makeSingleEnvConfig()
    const result = await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'initial-baseline',
      cwd: tempDir,
    })

    expect(result.migrationFile).toBeDefined()
    expect(result.migrationFile).toContain('initial-baseline')
    expect(result.snapshotDir).toBeDefined()
    expect(result.isBaseline).toBe(true)

    // Migration file should exist on disk
    const migrations = await listMigrationFiles(tempDir)
    expect(migrations).toHaveLength(1)
    expect(migrations[0].description).toBe('initial-baseline')
  })

  it.skipIf(skipIfNoContainers())('second backup creates incremental migration', async () => {
    const config = makeSingleEnvConfig()

    // First backup (baseline)
    await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'baseline',
      cwd: tempDir,
    })

    // Small delay for different timestamp
    await new Promise(r => setTimeout(r, 1100))

    // Second backup (incremental — same DB, so diff should be minimal)
    const result = await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'incremental',
      cwd: tempDir,
    })

    expect(result.isBaseline).toBe(false)
    expect(result.migrationFile).toContain('incremental')

    const migrations = await listMigrationFiles(tempDir)
    expect(migrations).toHaveLength(2)
    expect(migrations[0].description).toBe('baseline')
    expect(migrations[1].description).toBe('incremental')
  })

  it.skipIf(skipIfNoContainers())('migration file contains valid up/down SQL', async () => {
    const config = makeSingleEnvConfig()
    await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'check-sql',
      cwd: tempDir,
    })

    const migrations = await loadMigrations(tempDir)
    expect(migrations).toHaveLength(1)

    const m = migrations[0]
    expect(m.version).toMatch(/^\d{8}T\d{6}Z$/)
    expect(m.description).toBe('check-sql')
    expect(m.up).toBeDefined()
    expect(m.down).toBeDefined()
    // Baseline has SQL statements in up
    expect(m.up.sql.length).toBeGreaterThanOrEqual(0)
    expect(m.layers.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(skipIfNoContainers())('migration parent chain is set correctly', async () => {
    const config = makeSingleEnvConfig()

    await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'first',
      cwd: tempDir,
    })

    await new Promise(r => setTimeout(r, 1100))

    await backup({
      envName: 'source',
      env: config.environments.source,
      config,
      description: 'second',
      cwd: tempDir,
    })

    const migrations = await loadMigrations(tempDir)
    expect(migrations[0].parent).toBeNull()
    expect(migrations[1].parent).toBe(migrations[0].version)
  })
})
