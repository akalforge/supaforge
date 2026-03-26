/**
 * E2E: Post-promote verification (runs LAST alphabetically).
 *
 * After individual layer tests (cron, rls, storage, webhooks) have each
 * promoted their fixes, this test re-scans everything and verifies the
 * target is (mostly) clean.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { createDefaultRegistry } from '../../../src/layers/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult, LayerName } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

const TESTABLE_LAYERS: LayerName[] = ['rls', 'cron', 'webhooks', 'storage']

describe('e2e: post-promote verification', () => {
  let config: SupaForgeConfig
  let result: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    result = await scan(registry, { config, layers: TESTABLE_LAYERS })
  })

  it.skipIf(shouldSkip())('should have no errors after all promotes', () => {
    const errorLayers = result.layers.filter(l => l.status === 'error')
    expect(errorLayers, `Error layers: ${JSON.stringify(errorLayers)}`).toHaveLength(0)
  })

  it.skipIf(shouldSkip())('should have no critical issues remaining', () => {
    expect(result.summary.critical).toBe(0)
  })

  it.skipIf(shouldSkip())('should have improved score', () => {
    // After all layer promotes, score should be high
    expect(result.score).toBeGreaterThanOrEqual(80)
  })
})
