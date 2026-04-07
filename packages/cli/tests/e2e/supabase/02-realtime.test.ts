/**
 * E2E: Realtime publication drift detection and promotion.
 *
 * Tests against real Supabase instances with:
 *   - Missing publication: supaforge_live (publishes posts + payments in source)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: realtime layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['realtime'] })
  })

  it.skipIf(shouldSkip())('should detect realtime drift', () => {
    const rt = initialScan.checks.find(l => l.check === 'realtime')!
    expect(rt.status).toBe('drifted')
  })

  it.skipIf(shouldSkip())('should detect missing supaforge_live publication', () => {
    const rt = initialScan.checks.find(l => l.check === 'realtime')!

    const missing = rt.issues.find(i => i.id === 'realtime-missing-pub-supaforge_live')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('supaforge_live')
    expect(missing!.sql?.up).toContain('CREATE PUBLICATION')
    expect(missing!.sql?.up).toContain('posts')
    expect(missing!.sql?.up).toContain('payments')
    expect(missing!.sql?.down).toContain('DROP PUBLICATION')
  })

  it.skipIf(shouldSkip())('should not flag supabase_realtime as drifted', () => {
    const rt = initialScan.checks.find(l => l.check === 'realtime')!

    // supabase_realtime is excluded by the check (internal publication)
    const internal = rt.issues.find(i => i.id.includes('supabase_realtime'))
    expect(internal).toBeUndefined()
  })

  it.skipIf(shouldSkip())('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['realtime'],
      dryRun: true,
    })

    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['realtime'] })
    expect(rescan.checks[0].issues.length).toBe(initialScan.checks[0].issues.length)
  })

  it.skipIf(shouldSkip())('should promote realtime fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['realtime'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: supaforge_live should now exist
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['realtime'] })
    const rtResult = rescan.checks.find(l => l.check === 'realtime')!

    const missingPub = rtResult.issues.find(i => i.id === 'realtime-missing-pub-supaforge_live')
    expect(missingPub).toBeUndefined()
  })
})
