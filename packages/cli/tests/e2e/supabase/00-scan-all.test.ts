/**
 * E2E: Full multi-layer scan (detection only).
 *
 * Runs FIRST (alphabetically) before individual layer tests promote fixes.
 * Validates that all testable layers detect drift without errors.
 *
 * Note: schema + data layers depend on @dbdiff/cli (tested separately).
 *       edge-functions + auth layers require Management API (cloud-only, tested via unit tests).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/layers/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult, LayerName } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

/** Layers testable against local Supabase (no Management API needed). */
const TESTABLE_LAYERS: LayerName[] = ['rls', 'cron', 'webhooks', 'storage']

describe('e2e: full multi-layer scan', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, layers: TESTABLE_LAYERS })
  })

  it.skipIf(shouldSkip())('should scan all layers without errors', () => {
    const errorLayers = initialScan.layers.filter(l => l.status === 'error')
    expect(errorLayers, `Error layers: ${JSON.stringify(errorLayers)}`).toHaveLength(0)
  })

  it.skipIf(shouldSkip())('should detect drift across multiple layers', () => {
    const driftedLayers = initialScan.layers.filter(l => l.status === 'drifted')
    expect(driftedLayers.length).toBeGreaterThanOrEqual(3)

    // Score should reflect issues
    expect(initialScan.score).toBeLessThan(100)
    expect(initialScan.summary.total).toBeGreaterThanOrEqual(5)
    expect(initialScan.summary.critical).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(shouldSkip())('should have issues with SQL fixes or API actions', () => {
    const allIssues = initialScan.layers.flatMap(l => l.issues)

    const withSql = allIssues.filter(i => i.sql?.up)
    const withAction = allIssues.filter(i => i.action)
    const withFixes = withSql.length + withAction.length
    expect(withFixes, 'issues with SQL fixes or API actions').toBeGreaterThanOrEqual(3)
  })

  it.skipIf(shouldSkip())('dry-run should list all fixes without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      layers: TESTABLE_LAYERS.map(String),
      dryRun: true,
    })

    expect(result.errors).toHaveLength(0)
    expect(result.applied.length).toBeGreaterThanOrEqual(5)

    // Verify nothing changed (dry-run only)
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, layers: TESTABLE_LAYERS })
    expect(rescan.summary.total).toBe(initialScan.summary.total)
  })
})
