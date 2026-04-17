/**
 * E2E: Snapshot capture against a real Supabase instance.
 *
 * Tests that captureSnapshot() produces a valid manifest and layer files
 * when pointed at the source Supabase environment.
 *
 * This is a read-only test — it does not modify any database state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureSnapshot, loadSnapshot } from '../../../src/snapshot'
import type { SupaForgeConfig, SnapshotManifest } from '../../../src/types/config'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: snapshot capture', () => {
  let config: SupaForgeConfig
  let tempDir: string
  let manifest: SnapshotManifest
  let snapshotDir: string

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig({ dataTables: ['plans'] })
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-e2e-snapshot-'))

    const result = await captureSnapshot({
      envName: 'source',
      env: config.environments.source,
      config,
      cwd: tempDir,
    })

    manifest = result.manifest
    snapshotDir = result.dir
  })

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it.skipIf(shouldSkip())('should create a valid manifest', () => {
    expect(manifest).toBeDefined()
    expect(manifest.version).toBe(1)
    expect(manifest.environment).toBe('source')
    expect(manifest.timestamp).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it.skipIf(shouldSkip())('should capture schema layer', () => {
    expect(manifest.layers.schema).toBeDefined()
    expect(manifest.layers.schema.captured).toBe(true)
    expect(manifest.layers.schema.file).toBe('schema.json')
    expect(manifest.layers.schema.itemCount).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(shouldSkip())('should capture RLS policies', () => {
    expect(manifest.layers.rls).toBeDefined()
    expect(manifest.layers.rls.captured).toBe(true)
    // Source has 5 policies: users_select_own, users_update_own,
    // posts_select_published, posts_select_own, posts_insert_own
    expect(manifest.layers.rls.itemCount).toBeGreaterThanOrEqual(5)
  })

  it.skipIf(shouldSkip())('should capture cron jobs', () => {
    expect(manifest.layers.cron).toBeDefined()
    expect(manifest.layers.cron.captured).toBe(true)
    // Source has: cleanup_sessions + weekly_digest
    expect(manifest.layers.cron.itemCount).toBeGreaterThanOrEqual(2)
  })

  it.skipIf(shouldSkip())('should capture webhooks', () => {
    expect(manifest.layers.webhooks).toBeDefined()
    expect(manifest.layers.webhooks.captured).toBe(true)
    // Source has: on_user_created + on_payment_received
    expect(manifest.layers.webhooks.itemCount).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(shouldSkip())('should capture extensions', () => {
    expect(manifest.layers.extensions).toBeDefined()
    expect(manifest.layers.extensions.captured).toBe(true)
    // At minimum: plpgsql, pg_cron, pg_net
    expect(manifest.layers.extensions.itemCount).toBeGreaterThanOrEqual(3)
  })

  it.skipIf(shouldSkip())('should capture storage (at least policies via DB)', () => {
    expect(manifest.layers.storage).toBeDefined()
    // Storage may be partially captured (policies via DB, buckets require API)
    if (manifest.layers.storage.captured) {
      expect(manifest.layers.storage.itemCount).toBeGreaterThanOrEqual(1)
    }
  })

  it.skipIf(shouldSkip())('should write manifest.json to disk', async () => {
    const loaded = await loadSnapshot(snapshotDir)
    expect(loaded.version).toBe(1)
    expect(loaded.environment).toBe('source')
    expect(loaded.timestamp).toBe(manifest.timestamp)
  })

  it.skipIf(shouldSkip())('should write layer files to disk', async () => {
    const files = await readdir(snapshotDir)
    expect(files).toContain('manifest.json')
    expect(files).toContain('schema.json')
    expect(files).toContain('rls.sql')
    expect(files).toContain('cron.sql')
    expect(files).toContain('extensions.sql')
  })

  it.skipIf(shouldSkip())('schema.json should contain users table', async () => {
    const schema = await readFile(join(snapshotDir, 'schema.json'), 'utf-8')
    expect(schema).toContain('users')
  })

  it.skipIf(shouldSkip())('rls.sql should contain policy statements', async () => {
    const rls = await readFile(join(snapshotDir, 'rls.sql'), 'utf-8')
    expect(rls).toContain('CREATE POLICY')
    expect(rls).toContain('users_select_own')
  })
})
