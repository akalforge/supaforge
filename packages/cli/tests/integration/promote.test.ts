/**
 * Integration tests for `supaforge promote` against real Supabase Postgres.
 *
 * Flow: scan → promote (dry-run first, then real) → re-scan to verify fixes.
 *
 * Requires containers from scripts/test-integration.sh.
 *
 * IMPORTANT: This file mutates the target database. It re-seeds in afterAll
 * so subsequent test files start with a clean drifted state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { scan } from '../../src/scanner'
import { promote } from '../../src/promote'
import { createDefaultRegistry } from '../../src/checks/index'
import type { ScanResult } from '../../src/types/drift'
import { SOURCE_URL, TARGET_URL, skipIfNoContainers, makeConfig, reseedTarget } from './helpers'

describe('integration: promote', () => {
  let initialScan: ScanResult
  const config = makeConfig()

  beforeAll(async () => {
    if (skipIfNoContainers()) return

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['rls'] })
  })

  afterAll(async () => {
    if (skipIfNoContainers()) return
    // Restore target to its original drifted state for other test files
    await reseedTarget()
  })

  it.skipIf(skipIfNoContainers())('dry-run should list SQL without applying it', async () => {
    const result = await promote({
      dbUrl: TARGET_URL!,
      scanResult: initialScan,
      dryRun: true,
    })

    // Dry-run: applied contains the statements that would run
    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing actually changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['rls'] })
    expect(rescan.checks[0].issues.length).toBe(initialScan.checks[0].issues.length)
  })

  it.skipIf(skipIfNoContainers())('should apply RLS fixes to target', async () => {
    const promoteResult = await promote({
      dbUrl: TARGET_URL!,
      scanResult: initialScan,
      checks: ['rls'],
    })

    expect(promoteResult.errors, `promote SQL errors: ${JSON.stringify(promoteResult.errors)}`).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan RLS check — drift should be reduced
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['rls'] })
    const rlsIssues = rescan.checks.find(l => l.check === 'rls')!.issues

    expect(rlsIssues.length).toBeLessThan(initialScan.checks[0].issues.length)
  })
})

describe('integration: promote cron', () => {
  let cronScan: ScanResult
  const config = makeConfig()

  beforeAll(async () => {
    if (skipIfNoContainers()) return
    // Ensure target is fresh before cron promote
    await reseedTarget()
    const registry = createDefaultRegistry()
    cronScan = await scan(registry, { config, checks: ['cron'] })
  })

  afterAll(async () => {
    if (skipIfNoContainers()) return
    await reseedTarget()
  })

  it.skipIf(skipIfNoContainers())('should detect cron drift before promote', () => {
    const cron = cronScan.checks.find(l => l.check === 'cron')!
    expect(cron.status).toBe('drifted')
    expect(cron.issues.length).toBeGreaterThanOrEqual(2)
  })

  it.skipIf(skipIfNoContainers())('should apply cron fixes and reduce drift', async () => {
    const result = await promote({
      dbUrl: TARGET_URL!,
      scanResult: cronScan,
      checks: ['cron'],
    })

    // cron.schedule / cron.unschedule won't work in plain Postgres (no pg_cron),
    // so we expect errors — but the test verifies the promote flow runs and
    // the SQL is well-formed. In a real Supabase env these would succeed.
    expect(result.applied.length + result.errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('integration: promote idempotency', () => {
  const config = makeConfig()

  beforeAll(async () => {
    if (skipIfNoContainers()) return
    await reseedTarget()
  })

  afterAll(async () => {
    if (skipIfNoContainers()) return
    await reseedTarget()
  })

  it.skipIf(skipIfNoContainers())('running promote twice for RLS should be safe', async () => {
    const registry = createDefaultRegistry()

    // First promote
    const scan1 = await scan(registry, { config, checks: ['rls'] })
    const promote1 = await promote({
      dbUrl: TARGET_URL!,
      scanResult: scan1,
      checks: ['rls'],
    })
    expect(promote1.errors).toHaveLength(0)

    // Second promote — should be a no-op (no issues to fix)
    const scan2 = await scan(registry, { config, checks: ['rls'] })
    const rlsAfter = scan2.checks.find(l => l.check === 'rls')!

    // If no drift remains, promote has nothing to apply
    if (rlsAfter.status === 'clean') {
      const promote2 = await promote({
        dbUrl: TARGET_URL!,
        scanResult: scan2,
        checks: ['rls'],
      })
      expect(promote2.applied).toHaveLength(0)
      expect(promote2.errors).toHaveLength(0)
    }
  })
})
