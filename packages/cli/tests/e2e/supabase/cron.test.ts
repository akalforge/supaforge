/**
 * E2E: Cron job drift detection and promotion (real pg_cron).
 *
 * Tests against real Supabase instances with:
 *   - Modified schedule: cleanup_sessions (0 6 vs 0 3)
 *   - Missing job: weekly_digest
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: cron layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['cron'] })
  })

  it.skipIf(shouldSkip())('should detect missing weekly_digest job', () => {
    const cron = initialScan.checks.find(l => l.check === 'cron')!
    expect(cron.status).toBe('drifted')

    const missing = cron.issues.find(i => i.id.includes('weekly_digest'))
    expect(missing).toBeDefined()
    expect(missing!.title).toContain('Missing')
    expect(missing!.sql?.up).toContain('cron.schedule')
    expect(missing!.sql?.down).toContain('cron.unschedule')
  })

  it.skipIf(shouldSkip())('should detect modified cleanup_sessions schedule', () => {
    const cron = initialScan.checks.find(l => l.check === 'cron')!

    const modified = cron.issues.find(i => i.id.includes('cleanup_sessions'))
    expect(modified).toBeDefined()
    expect(modified!.title).toContain('Modified')
    expect(modified!.sql?.up).toContain('cron.unschedule')
    expect(modified!.sql?.up).toContain('cron.schedule')
  })

  it.skipIf(shouldSkip())('should promote cron fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['cron'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: cron drift should be resolved
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['cron'] })
    const cronResult = rescan.checks.find(l => l.check === 'cron')!

    // Missing weekly_digest should now exist
    const missingDigest = cronResult.issues.find(i => i.id.includes('weekly_digest') && i.title.includes('Missing'))
    expect(missingDigest).toBeUndefined()

    // Modified cleanup_sessions should be fixed
    const modifiedCleanup = cronResult.issues.find(i => i.id.includes('cleanup_sessions') && i.title.includes('Modified'))
    expect(modifiedCleanup).toBeUndefined()
  })
})
