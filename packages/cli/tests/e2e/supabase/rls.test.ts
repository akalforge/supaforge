/**
 * E2E: RLS policy drift detection and promotion.
 *
 * Tests against real Supabase instances with:
 *   - Missing policy: posts_insert_own (CVE-2025-48757 pattern)
 *   - Modified policy: users_select_own (USING expression changed)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/layers/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: RLS layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, layers: ['rls'] })
  })

  it.skipIf(shouldSkip())('should detect missing posts_insert_own policy', () => {
    const rls = initialScan.layers.find(l => l.layer === 'rls')!
    expect(rls.status).toBe('drifted')

    const missing = rls.issues.find(i => i.id.includes('posts_insert_own'))
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('critical')
    expect(missing!.sql?.up).toContain('CREATE POLICY')
    expect(missing!.sql?.down).toContain('DROP POLICY')
  })

  it.skipIf(shouldSkip())('should detect modified users_select_own policy', () => {
    const rls = initialScan.layers.find(l => l.layer === 'rls')!

    const modified = rls.issues.find(i => i.id.includes('users_select_own'))
    expect(modified).toBeDefined()
    expect(modified!.severity).toBe('critical')
    expect(modified!.sql?.up).toContain('DROP POLICY')
    expect(modified!.sql?.up).toContain('CREATE POLICY')
  })

  it.skipIf(shouldSkip())('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      layers: ['rls'],
      dryRun: true,
    })

    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, layers: ['rls'] })
    expect(rescan.layers[0].issues.length).toBe(initialScan.layers[0].issues.length)
  })

  it.skipIf(shouldSkip())('should promote RLS fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      layers: ['rls'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: drift should be resolved
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, layers: ['rls'] })
    const rlsResult = rescan.layers.find(l => l.layer === 'rls')!

    // Missing posts_insert_own should now exist
    const missingInsert = rlsResult.issues.find(
      i => i.id.includes('posts_insert_own') && i.severity === 'critical',
    )
    expect(missingInsert).toBeUndefined()

    // Modified users_select_own should be fixed
    const modifiedSelect = rlsResult.issues.find(
      i => i.id.includes('users_select_own') && i.id.includes('modified'),
    )
    expect(modifiedSelect).toBeUndefined()
  })
})
