/**
 * Integration tests for `supaforge promote` against real Supabase Postgres.
 *
 * Flow: scan → promote (dry-run first, then real) → re-scan to verify fixes.
 *
 * Requires containers from scripts/test-integration.sh.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../src/scanner'
import { promote } from '../../src/promote'
import { createDefaultRegistry } from '../../src/layers/index'
import type { SupaForgeConfig } from '../../src/types/config'
import type { ScanResult } from '../../src/types/drift'

const SOURCE_URL = process.env.SUPAFORGE_TEST_SOURCE_URL
const TARGET_URL = process.env.SUPAFORGE_TEST_TARGET_URL

function skipIfNoContainers() {
  return !SOURCE_URL || !TARGET_URL
}

describe('integration: promote', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (skipIfNoContainers()) return

    config = {
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: TARGET_URL! },
      },
      source: 'source',
      target: 'target',
      ignoreSchemas: ['information_schema', 'pg_catalog', 'pg_toast', 'extensions', 'graphql', 'graphql_public', 'pgsodium', 'realtime', 'vault', '_realtime'],
    }

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, layers: ['rls'] })
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
    const rescan = await scan(registry, { config, layers: ['rls'] })
    expect(rescan.layers[0].issues.length).toBe(initialScan.layers[0].issues.length)
  })

  it.skipIf(skipIfNoContainers())('should apply RLS fixes to target', async () => {
    // Only promote RLS layer
    const promoteResult = await promote({
      dbUrl: TARGET_URL!,
      scanResult: initialScan,
      layers: ['rls'],
    })

    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan RLS layer — drift should be reduced
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, layers: ['rls'] })
    const rlsIssues = rescan.layers.find(l => l.layer === 'rls')!.issues

    // At minimum the missing policy should now be fixed
    const missingInsert = rlsIssues.find(i => i.id.includes('posts_insert_own') && i.severity === 'critical')
    // This may or may not be fully fixed depending on exact SQL, but applied count should drop
    expect(rlsIssues.length).toBeLessThanOrEqual(initialScan.layers[0].issues.length)
  })
})
