/**
 * E2E: Webhook drift detection and promotion (real supabase_functions + pg_net).
 *
 * Tests against real Supabase instances with:
 *   - pg_net extension: enabled in source, missing in target
 *   - Missing webhook: on_payment_received
 *   - Extra webhook: on_invoice_sent
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/layers/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: webhooks layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, layers: ['webhooks'] })
  })

  it.skipIf(shouldSkip())('should detect pg_net extension status in target', () => {
    const webhooks = initialScan.layers.find(l => l.layer === 'webhooks')!
    expect(webhooks.status).toBe('drifted')

    const pgnet = webhooks.issues.find(i => i.id === 'webhooks-pgnet-missing')
    // pg_net may already be installed if another test promoted first
    if (pgnet) {
      expect(pgnet.severity).toBe('critical')
      expect(pgnet.sql?.up).toContain('CREATE EXTENSION')
      expect(pgnet.sql?.down).toContain('DROP EXTENSION')
    }
  })

  it.skipIf(shouldSkip())('should detect missing on_payment_received webhook', () => {
    const webhooks = initialScan.layers.find(l => l.layer === 'webhooks')!

    const missing = webhooks.issues.find(i => i.id.includes('on_payment_received'))
    expect(missing).toBeDefined()
    expect(missing!.title).toContain('Missing')
    // Should have trigger metadata
    expect(missing!.sourceValue).toBeDefined()
  })

  it.skipIf(shouldSkip())('should detect extra on_invoice_sent webhook', () => {
    const webhooks = initialScan.layers.find(l => l.layer === 'webhooks')!

    const extra = webhooks.issues.find(i => i.id.includes('on_invoice_sent'))
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
    expect(extra!.title).toContain('Extra')
  })

  it.skipIf(shouldSkip())('should promote webhook fixes', async () => {
    // Only promote SQL-based fixes (pg_net extension + webhook hooks with triggers)
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      layers: ['webhooks'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)

    // pg_net creation and any webhook SQL should be applied
    const appliedSql = promoteResult.applied.filter(a => a.sql)
    expect(appliedSql.length).toBeGreaterThanOrEqual(1)

    // Re-scan: pg_net should now be installed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, layers: ['webhooks'] })
    const webhooksResult = rescan.layers.find(l => l.layer === 'webhooks')!

    const pgnetMissing = webhooksResult.issues.find(i => i.id === 'webhooks-pgnet-missing')
    expect(pgnetMissing).toBeUndefined()
  })
})
