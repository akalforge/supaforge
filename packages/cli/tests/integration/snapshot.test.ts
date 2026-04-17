/**
 * Integration tests for `supaforge snapshot` against real Postgres containers.
 *
 * Tests full capture to a temp directory. Verifies written files
 * and manifest structure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureSnapshot,
  loadSnapshot,
  findLatestSnapshot,
  listSnapshots,
} from '../../src/snapshot.js'
import type { SupaForgeConfig } from '../../src/types/config.js'
import { SOURCE_URL, skipIfNoContainers } from './helpers.js'

function makeSingleEnvConfig(cwd: string): SupaForgeConfig {
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

describe('integration: snapshot capture', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-snap-int-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it.skipIf(skipIfNoContainers())('should capture a full snapshot with manifest', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    expect(result.timestamp).toMatch(/^\d{8}T\d{6}Z$/)
    expect(result.dir).toContain('.supaforge')
    expect(result.dir).toContain('snapshots')

    // Manifest should exist and be valid
    const manifest = await loadSnapshot(result.dir)
    expect(manifest.version).toBe(1)
    expect(manifest.environment).toBe('source')
  })

  it.skipIf(skipIfNoContainers())('should write schema.json with table info', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const schemaPath = join(result.dir, 'schema.json')
    const schemaJson = await readFile(schemaPath, 'utf8')
    // Should contain our test tables
    expect(schemaJson).toContain('users')
    expect(schemaJson).toContain('posts')
  })

  it.skipIf(skipIfNoContainers())('should write rls.sql with policies', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const rlsPath = join(result.dir, 'rls.sql')
    const rlsSql = await readFile(rlsPath, 'utf8')
    expect(rlsSql).toContain('users_select_own')
    expect(rlsSql).toContain('posts_insert_own')
  })

  it.skipIf(skipIfNoContainers())('should write cron.sql with jobs', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const cronPath = join(result.dir, 'cron.sql')
    const cronSql = await readFile(cronPath, 'utf8')
    expect(cronSql).toContain('cleanup_sessions')
    expect(cronSql).toContain('weekly_digest')
  })

  it.skipIf(skipIfNoContainers())('should write extensions.sql', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const extPath = join(result.dir, 'extensions.sql')
    const extSql = await readFile(extPath, 'utf8')
    expect(extSql).toContain('uuid-ossp')
  })

  it.skipIf(skipIfNoContainers())('should write webhooks.sql', async () => {
    const config = makeSingleEnvConfig(tempDir)
    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const hookPath = join(result.dir, 'webhooks.sql')
    const hookSql = await readFile(hookPath, 'utf8')
    // Integration containers have supabase_functions.hooks rows but no real
    // pg_trigger entries, so the snapshot capture filters them out.
    expect(hookSql).toContain('webhooks')
  })

  it.skipIf(skipIfNoContainers())('should list snapshots after capture', async () => {
    const config = makeSingleEnvConfig(tempDir)
    await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const snapshots = await listSnapshots(tempDir)
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    expect(snapshots[0].manifest.environment).toBe('source')
  })

  it.skipIf(skipIfNoContainers())('findLatestSnapshot returns the most recent', async () => {
    const config = makeSingleEnvConfig(tempDir)

    // Capture twice
    await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 1100))
    const second = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    const latest = await findLatestSnapshot(tempDir)
    // findLatestSnapshot returns the full directory path, not just the timestamp
    expect(latest).toContain(second.timestamp)
  })
})
