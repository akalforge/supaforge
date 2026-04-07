/**
 * Integration tests for SupaForge layers against real Supabase Postgres.
 *
 * These tests are read-only — they scan but do not modify the target database.
 * Requires running containers (see scripts/test-integration.sh).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../src/scanner'
import { createDefaultRegistry } from '../../src/checks/index'
import type { ScanResult } from '../../src/types/drift'
import { SOURCE_URL, TARGET_URL, skipIfNoContainers, makeConfig } from './helpers'

describe('integration: full scan', () => {
  let result: ScanResult
  const config = makeConfig()

  beforeAll(async () => {
    if (skipIfNoContainers()) return

    const registry = createDefaultRegistry()
    result = await scan(registry, { config })
  })

  it.skipIf(skipIfNoContainers())('should complete without errors', () => {
    const errorLayers = result.checks.filter(l => l.status === 'error')
    expect(errorLayers).toHaveLength(0)
  })

  it.skipIf(skipIfNoContainers())('should produce schema layer results', () => {
    const schema = result.checks.find(l => l.check === 'schema')!
    expect(schema).toBeDefined()
    expect(schema.status).toBe('drifted')
    // The bio column and idx_posts_published index are missing from target
    expect(schema.issues.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(skipIfNoContainers())('should detect RLS drift', () => {
    const rls = result.checks.find(l => l.check === 'rls')!
    expect(rls.status).toBe('drifted')
    expect(rls.issues.length).toBeGreaterThanOrEqual(1)

    // Missing posts_insert_own policy should be critical
    const missingInsert = rls.issues.find(i => i.id.includes('posts_insert_own'))
    expect(missingInsert).toBeDefined()
    expect(missingInsert!.severity).toBe('critical')

    // Modified users_select_own USING expression
    const modifiedSelect = rls.issues.find(i => i.id.includes('users_select_own'))
    expect(modifiedSelect).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should detect cron drift', () => {
    const cron = result.checks.find(l => l.check === 'cron')!
    expect(cron.status).toBe('drifted')

    // Missing weekly_digest
    const missingDigest = cron.issues.find(i => i.id.includes('weekly_digest'))
    expect(missingDigest).toBeDefined()

    // Modified cleanup_sessions schedule (0 3 vs 0 6)
    const modifiedCleanup = cron.issues.find(i => i.id.includes('cleanup_sessions'))
    expect(modifiedCleanup).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should detect webhook drift', () => {
    const webhooks = result.checks.find(l => l.check === 'webhooks')!
    expect(webhooks.status).toBe('drifted')

    // Missing on_payment_received webhook
    const missingPayment = webhooks.issues.find(i => i.id.includes('on_payment_received'))
    expect(missingPayment).toBeDefined()

    // Extra on_invoice_sent webhook
    const extraInvoice = webhooks.issues.find(i => i.id.includes('on_invoice_sent'))
    expect(extraInvoice).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should detect storage policy drift', () => {
    const storage = result.checks.find(l => l.check === 'storage')!
    // Storage layer should detect policy drift (missing insert, modified select)
    // Bucket detection is skipped because we don't have API keys
    expect(storage.status).toBe('drifted')

    // Missing storage_objects_insert_own policy
    const missingInsert = storage.issues.find(i => i.id.includes('storage_objects_insert_own'))
    expect(missingInsert).toBeDefined()
    expect(missingInsert!.severity).toBe('critical')

    // Modified storage_objects_select_own policy
    const modifiedSelect = storage.issues.find(i => i.id.includes('storage_objects_select_own'))
    expect(modifiedSelect).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should produce a score below 100', () => {
    expect(result.score).toBeLessThan(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(skipIfNoContainers())('should have critical issues in summary', () => {
    expect(result.summary.critical).toBeGreaterThanOrEqual(1)
    expect(result.summary.total).toBeGreaterThanOrEqual(3)
  })

  it.skipIf(skipIfNoContainers())('should include all 8 layers in results', () => {
    const checkNames = result.checks.map(l => l.check)
    expect(checkNames).toContain('schema')
    expect(checkNames).toContain('rls')
    expect(checkNames).toContain('edge-functions')
    expect(checkNames).toContain('storage')
    expect(checkNames).toContain('auth')
    expect(checkNames).toContain('cron')
    expect(checkNames).toContain('data')
    expect(checkNames).toContain('webhooks')
  })

  it.skipIf(skipIfNoContainers())('should gracefully skip API-dependent layers', () => {
    // Without projectRef/apiKey, auth and edge-functions should be clean (no-op)
    const auth = result.checks.find(l => l.check === 'auth')!
    const edgeFn = result.checks.find(l => l.check === 'edge-functions')!
    expect(auth.status).not.toBe('error')
    expect(edgeFn.status).not.toBe('error')
  })
})

describe('integration: single-layer scan', () => {
  it.skipIf(skipIfNoContainers())('should scan only RLS when --check=rls', async () => {
    const config = makeConfig()
    const registry = createDefaultRegistry()
    const result = await scan(registry, { config, checks: ['rls'] })

    // Only rls should be present, rest skipped
    const active = result.checks.filter(l => l.status !== 'skipped')
    expect(active).toHaveLength(1)
    expect(active[0].check).toBe('rls')
  })

  it.skipIf(skipIfNoContainers())('should scan only storage when --check=storage', async () => {
    const config = makeConfig()
    const registry = createDefaultRegistry()
    const result = await scan(registry, { config, checks: ['storage'] })

    const active = result.checks.filter(l => l.status !== 'skipped')
    expect(active).toHaveLength(1)
    expect(active[0].check).toBe('storage')
    // Should detect the storage policy drift
    expect(active[0].issues.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(skipIfNoContainers())('should return clean when diffing source against itself', async () => {
    const config = makeConfig({
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: SOURCE_URL! },
      },
    })
    const registry = createDefaultRegistry()
    const result = await scan(registry, { config, checks: ['rls', 'cron', 'webhooks', 'storage'] })

    for (const c of result.checks) {
      if (c.status === 'skipped') continue
      expect(c.issues, `${c.check} should be clean`).toHaveLength(0)
    }
    expect(result.score).toBe(100)
  })
})
