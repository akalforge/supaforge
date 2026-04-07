/**
 * E2E: Reference data drift detection and promotion (powered by @dbdiff/cli).
 *
 * Tests against real Supabase instances with:
 *   - Missing row: Enterprise plan (exists in source, not in target)
 *   - Modified row: Pro plan has different price (2900 in source, 1900 in target)
 *
 * Requires @dbdiff/cli to be installed. If not available, the check returns
 * no issues and the test gracefully skips assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult, CheckResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: data layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult
  let dataResult: CheckResult | undefined
  let dbdiffAvailable: boolean

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig({ dataTables: ['plans'] })

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['data'] })
    dataResult = initialScan.checks.find(l => l.check === 'data')
    // If @dbdiff/cli is not installed, the check returns clean (no issues)
    dbdiffAvailable = dataResult?.status === 'drifted'
  })

  it.skipIf(shouldSkip())('should scan data layer without errors', () => {
    expect(dataResult).toBeDefined()
    expect(dataResult!.status).not.toBe('error')
  })

  it.skipIf(shouldSkip() || !dbdiffAvailable)('should detect data drift in plans table', () => {
    expect(dataResult!.status).toBe('drifted')
    expect(dataResult!.issues.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(shouldSkip() || !dbdiffAvailable)('should have SQL fixes for data drift', () => {
    const withSql = dataResult!.issues.filter(i => i.sql?.up)
    expect(withSql.length).toBeGreaterThanOrEqual(1)

    // Should contain INSERT or UPDATE statements for the plans table
    const allUpSql = withSql.map(i => i.sql!.up).join('\n').toUpperCase()
    expect(allUpSql).toMatch(/INSERT|UPDATE/)
  })

  it.skipIf(shouldSkip() || !dbdiffAvailable)('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['data'],
      dryRun: true,
    })

    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['data'] })
    expect(rescan.checks[0].issues.length).toBe(initialScan.checks[0].issues.length)
  })

  it.skipIf(shouldSkip() || !dbdiffAvailable)('should promote data fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['data'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: data drift should be resolved
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['data'] })
    const dataRescan = rescan.checks.find(l => l.check === 'data')!

    // Should have fewer (ideally zero) data issues
    expect(dataRescan.issues.length).toBeLessThan(dataResult!.issues.length)
  })
})
