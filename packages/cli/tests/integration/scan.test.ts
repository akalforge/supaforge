/**
 * Integration tests for SupaForge layers against real Supabase Postgres.
 *
 * These tests require running containers (see scripts/test-integration.sh).
 * They read connection URLs from environment variables:
 *   SUPAFORGE_TEST_SOURCE_URL
 *   SUPAFORGE_TEST_TARGET_URL
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../src/scanner'
import { createDefaultRegistry } from '../../src/layers/index'
import type { SupaForgeConfig } from '../../src/types/config'
import type { ScanResult, LayerName } from '../../src/types/drift'

const SOURCE_URL = process.env.SUPAFORGE_TEST_SOURCE_URL
const TARGET_URL = process.env.SUPAFORGE_TEST_TARGET_URL

function skipIfNoContainers() {
  if (!SOURCE_URL || !TARGET_URL) {
    return true
  }
  return false
}

describe('integration: full scan', () => {
  let result: ScanResult
  let config: SupaForgeConfig

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
    result = await scan(registry, { config })
  })

  it.skipIf(skipIfNoContainers())('should complete without errors', () => {
    const errorLayers = result.layers.filter(l => l.status === 'error')
    expect(errorLayers).toHaveLength(0)
  })

  it.skipIf(skipIfNoContainers())('should detect RLS drift', () => {
    const rls = result.layers.find(l => l.layer === 'rls')!
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
    const cron = result.layers.find(l => l.layer === 'cron')!
    expect(cron.status).toBe('drifted')

    // Missing weekly_digest
    const missingDigest = cron.issues.find(i => i.id.includes('weekly_digest'))
    expect(missingDigest).toBeDefined()

    // Modified cleanup_sessions schedule (0 3 vs 0 6)
    const modifiedCleanup = cron.issues.find(i => i.id.includes('cleanup_sessions'))
    expect(modifiedCleanup).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should detect webhook drift', () => {
    const webhooks = result.layers.find(l => l.layer === 'webhooks')!
    expect(webhooks.status).toBe('drifted')

    // NOTE: pg_net drift not testable with plain postgres (covered by unit tests)

    // Missing on_payment_received webhook
    const missingPayment = webhooks.issues.find(i => i.id.includes('on_payment_received'))
    expect(missingPayment).toBeDefined()

    // Extra on_invoice_sent webhook
    const extraInvoice = webhooks.issues.find(i => i.id.includes('on_invoice_sent'))
    expect(extraInvoice).toBeDefined()
  })

  it.skipIf(skipIfNoContainers())('should produce a score below 100', () => {
    expect(result.score).toBeLessThan(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(skipIfNoContainers())('should have critical issues in summary', () => {
    expect(result.summary.critical).toBeGreaterThanOrEqual(1)
    expect(result.summary.total).toBeGreaterThanOrEqual(3)
  })
})

describe('integration: single-layer scan', () => {
  it.skipIf(skipIfNoContainers())('should scan only RLS when --layer=rls', async () => {
    const config: SupaForgeConfig = {
      environments: {
        source: { dbUrl: SOURCE_URL! },
        target: { dbUrl: TARGET_URL! },
      },
      source: 'source',
      target: 'target',
      ignoreSchemas: ['information_schema', 'pg_catalog', 'pg_toast', 'extensions', 'graphql', 'graphql_public', 'pgsodium', 'realtime', 'vault', '_realtime'],
    }

    const registry = createDefaultRegistry()
    const result = await scan(registry, { config, layers: ['rls'] })

    // Only rls should be present, rest skipped
    const active = result.layers.filter(l => l.status !== 'skipped')
    expect(active).toHaveLength(1)
    expect(active[0].layer).toBe('rls')
  })
})
