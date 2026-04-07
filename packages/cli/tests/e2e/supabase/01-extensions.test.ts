/**
 * E2E: Postgres extensions drift detection and promotion.
 *
 * Tests against real Supabase instances with:
 *   - Missing extension: pg_net (enabled in source, missing in target)
 *
 * Runs BEFORE webhooks.test.ts (alphabetically) so that pg_net is still
 * missing when this test executes.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: extensions layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['extensions'] })
  })

  it.skipIf(shouldSkip())('should detect extensions drift', () => {
    const ext = initialScan.checks.find(l => l.check === 'extensions')!
    expect(ext.status).toBe('drifted')
  })

  it.skipIf(shouldSkip())('should detect missing pg_net extension', () => {
    const ext = initialScan.checks.find(l => l.check === 'extensions')!

    const missing = ext.issues.find(i => i.id === 'ext-missing-pg_net')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('pg_net')
    expect(missing!.sql?.up).toContain('CREATE EXTENSION')
    expect(missing!.sql?.down).toContain('DROP EXTENSION')
  })

  it.skipIf(shouldSkip())('should not flag shared base extensions as drifted', () => {
    const ext = initialScan.checks.find(l => l.check === 'extensions')!

    // Both instances should have plpgsql — it should not appear as missing/extra
    const plpgsql = ext.issues.find(i => i.id.includes('plpgsql'))
    expect(plpgsql).toBeUndefined()
  })

  it.skipIf(shouldSkip())('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['extensions'],
      dryRun: true,
    })

    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['extensions'] })
    expect(rescan.checks[0].issues.length).toBe(initialScan.checks[0].issues.length)
  })

  it.skipIf(shouldSkip())('should promote extension fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['extensions'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: pg_net should now be installed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['extensions'] })
    const extResult = rescan.checks.find(l => l.check === 'extensions')!

    const missingPgNet = extResult.issues.find(i => i.id === 'ext-missing-pg_net')
    expect(missingPgNet).toBeUndefined()
  })
})
