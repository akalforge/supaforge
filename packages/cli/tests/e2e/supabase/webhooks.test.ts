/**
 * E2E: Webhook drift detection and promotion (real supabase_functions + pg_net).
 *
 * Tests against real Supabase instances with:
 *   - pg_net extension: enabled in source, missing in target
 *   - Missing webhook: on_payment_received
 *   - Extra webhook: on_invoice_sent
 *   - Never-fired webhook: on_profile_updated (no invocation log rows)
 *   - Deleted webhook: on_legacy_deleted (log rows on the source, no trigger)
 *   - Repointed webhook: on_order_shipped (same name, table and events; the
 *     URL differs, and lives in the trigger's arguments)
 *
 * The last three are the cases a check reading supabase_functions.hooks — the
 * log of webhook *invocations* — cannot answer (issue #77). The fixtures seed
 * log rows alongside the triggers so that the log cannot be what answers them.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { pgQuery } from '../../../src/db'
import { createDefaultRegistry } from '../../../src/checks/index'
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
    initialScan = await scan(registry, { config, checks: ['webhooks'] })
  })

  it.skipIf(shouldSkip())('should detect pg_net extension status in target', () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!
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
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!

    const missing = webhooks.issues.find(i => i.id.includes('on_payment_received'))
    expect(missing).toBeDefined()
    expect(missing!.title).toContain('Missing')
    // Should have trigger metadata
    expect(missing!.sourceValue).toBeDefined()
  })

  it.skipIf(shouldSkip())('should detect extra on_invoice_sent webhook', () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!

    const extra = webhooks.issues.find(i => i.id.includes('on_invoice_sent'))
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
    expect(extra!.title).toContain('Extra')
  })

  // ── Reading the triggers rather than the invocation log (issue #77) ───────
  // Each of these is invisible to, or wrong in, a check that derives webhooks
  // from supabase_functions.hooks. The fixtures seed log rows alongside the
  // triggers precisely so the log cannot be what answers them.

  it.skipIf(shouldSkip())('should detect a webhook that has never fired', async () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!

    // on_profile_updated has no log rows on either side, so it had nothing to
    // be inferred from and was simply not seen.
    const missing = webhooks.issues.find(i => i.id.includes('on_profile_updated'))
    expect(missing).toBeDefined()
    expect(missing!.title).toContain('Missing')
    expect(missing!.sql?.up).toContain('example.invalid/profiles')
  })

  it.skipIf(shouldSkip())('should not report a webhook that was deleted', () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!

    // on_legacy_deleted exists only in the source's log. The webhook is gone
    // from both sides, so there is nothing to report — it used to be offered
    // as missing from the target, with a fix that could not work.
    expect(webhooks.issues.filter(i => i.id.includes('on_legacy_deleted'))).toHaveLength(0)
  })

  it.skipIf(shouldSkip())('should detect a webhook repointed at another URL', () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!

    // Same name, same table, same events: the comparison used to look at no
    // more than that and call these identical. The URL lives in the trigger's
    // arguments.
    const modified = webhooks.issues.find(i => i.id.includes('on_order_shipped'))
    expect(modified).toBeDefined()
    expect(modified!.title).toContain('Modified')
    expect(modified!.sql?.up).toContain('example.invalid/orders/v2')
  })

  it.skipIf(shouldSkip())('should carry the arguments into every generated fix', () => {
    const webhooks = initialScan.checks.find(l => l.check === 'webhooks')!
    const creates = webhooks.issues.filter(i => i.sql?.up.includes('CREATE TRIGGER'))

    expect(creates.length).toBeGreaterThanOrEqual(2)
    for (const issue of creates) {
      // `http_request()` with no arguments is what the old fix emitted, and it
      // makes every write to the table fail with `url argument is missing`.
      expect(issue.sql!.up, issue.id).not.toMatch(/http_request\(\s*\)/)
      // Nor may a fix recreate Supabase's own function as a side effect.
      expect(issue.sql!.up, issue.id).not.toContain('CREATE OR REPLACE FUNCTION')
    }
  })

  it.skipIf(shouldSkip())('should promote webhook fixes', async () => {
    // Only promote SQL-based fixes (pg_net extension + webhook hooks with triggers)
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['webhooks'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)

    // pg_net creation and any webhook SQL should be applied
    const appliedSql = promoteResult.applied.filter(a => a.sql)
    expect(appliedSql.length).toBeGreaterThanOrEqual(1)

    // Re-scan: pg_net should now be installed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['webhooks'] })
    const webhooksResult = rescan.checks.find(l => l.check === 'webhooks')!

    const pgnetMissing = webhooksResult.issues.find(i => i.id === 'webhooks-pgnet-missing')
    expect(pgnetMissing).toBeUndefined()
  })

  // ── What the applied fix leaves behind ────────────────────────────────────
  // Runs after the promote above, which is why it is ordered last in the file.

  it.skipIf(shouldSkip())('should leave Supabase\'s own http_request untouched', async () => {
    const targetUrl = process.env.SUPAFORGE_E2E_TARGET_DB_URL!
    const rows = await pgQuery(targetUrl, `
      SELECT p.prosrc, l.lanname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l  ON l.oid = p.prolang
      WHERE n.nspname = 'supabase_functions' AND p.proname = 'http_request'
    `) as unknown as { prosrc: string, lanname: string }[]

    expect(rows).toHaveLength(1)
    // Supabase's own implementation raises this; a stub recreated from the
    // source project's copy would not, and replacing it is what the previous
    // fix did as a side effect of syncing a webhook.
    expect(rows[0].prosrc).toContain('url argument is missing')
  })

  it.skipIf(shouldSkip())('should apply triggers that accept writes', async () => {
    const targetUrl = process.env.SUPAFORGE_E2E_TARGET_DB_URL!

    // The promoted trigger must carry its arguments, or this insert fails with
    // `url argument is missing` — the symptom that made the old fix worse than
    // the drift it was closing.
    const inserted = await pgQuery(
      targetUrl,
      `INSERT INTO public.payments (amount) VALUES (1) RETURNING id`,
    )
    expect(inserted).toHaveLength(1)

    const updated = await pgQuery(
      targetUrl,
      `UPDATE public.users SET email = email WHERE id = (
         SELECT id FROM public.users LIMIT 1
       ) RETURNING id`,
    )
    expect(Array.isArray(updated)).toBe(true)

    // And the arguments are really there, not merely tolerated.
    const defs = await pgQuery(targetUrl, `
      SELECT pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_proc p       ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal
        AND pn.nspname = 'supabase_functions'
        AND p.proname  = 'http_request'
    `) as unknown as { def: string }[]

    expect(defs.length).toBeGreaterThanOrEqual(2)
    for (const { def } of defs) {
      expect(def).not.toMatch(/http_request\(\s*\)/)
    }
  })
})
