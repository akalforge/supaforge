/**
 * E2E: Vault secret drift detection and promotion.
 *
 * Tests against real Supabase instances with:
 *   - Missing secret: smtp_password (source has api_key + smtp_password, target only has api_key)
 *
 * A missing secret is reported and never applied. The plaintext value exists
 * only in the source and Vault will not give it up, so there is nothing to
 * generate: the check hands over the exact `vault.create_secret` call to run by
 * hand, and `--apply` skips it with that as the reason.
 *
 * It used to generate `vault.create_secret('PLACEHOLDER_VALUE', …)` and apply
 * it. The target then held a live secret with a bogus value — so whatever read
 * it failed at runtime rather than failing loudly as absent — and because the
 * secret now existed, the next diff stopped asking for the manual step at all
 * (issue #91). These tests pin the absence of that SQL, which is the fix.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: vault layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  const missingSecret = (result: ScanResult) =>
    result.checks.find(l => l.check === 'vault')!.issues
      .find(i => i.id.includes('smtp_password') && i.title.includes('Missing'))

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['vault'] })
  })

  it.skipIf(shouldSkip())('should detect vault drift', () => {
    const vault = initialScan.checks.find(l => l.check === 'vault')!
    expect(vault.status).toBe('drifted')
  })

  it.skipIf(shouldSkip())('should detect missing smtp_password secret', () => {
    const missing = missingSecret(initialScan)

    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('smtp_password')
  })

  it.skipIf(shouldSkip())('offers no SQL for a secret it cannot read', () => {
    const missing = missingSecret(initialScan)!

    // The whole of #91: any SQL here is applied, and the only value available
    // to put in it is a placeholder.
    expect(missing.sql).toBeUndefined()
  })

  it.skipIf(shouldSkip())('hands over the command to run by hand instead', () => {
    const missing = missingSecret(initialScan)!

    expect(missing.manualOnly).toBeDefined()
    // Named, with the real value left as the one blank to fill.
    expect(missing.manualOnly).toContain('vault.create_secret')
    expect(missing.manualOnly).toContain('smtp_password')
    expect(missing.manualOnly).toContain('<value>')
    expect(missing.manualOnly).not.toContain('PLACEHOLDER_VALUE')
  })

  it.skipIf(shouldSkip())('should not flag api_key as missing (exists in both)', () => {
    const vault = initialScan.checks.find(l => l.check === 'vault')!

    const apiKeyMissing = vault.issues.find(
      i => i.id.includes('api_key') && i.title.includes('Missing'),
    )
    expect(apiKeyMissing).toBeUndefined()
  })

  it.skipIf(shouldSkip())('dry-run applies nothing and changes nothing', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['vault'],
      dryRun: true,
    })

    expect(result.applied.filter(a => a.sql)).toHaveLength(0)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['vault'] })
    const missingCount = rescan.checks[0].issues.filter(i => i.title.includes('Missing')).length
    expect(missingCount).toBe(initialScan.checks[0].issues.filter(i => i.title.includes('Missing')).length)
  })

  it.skipIf(shouldSkip())('skips the missing secret on apply, with the reason', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['vault'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)

    const skipped = promoteResult.skipped.find(s => s.issueId.includes('smtp_password'))
    expect(skipped, JSON.stringify(promoteResult.skipped)).toBeDefined()
    expect(skipped!.reason).toContain('vault.create_secret')
  })

  it.skipIf(shouldSkip())('keeps reporting the secret after an apply', async () => {
    // The second half of #91. A placeholder made the secret exist, so the next
    // diff went quiet about a step nobody had done — the report has to keep
    // asking until someone creates it for real.
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['vault'] })

    expect(missingSecret(rescan)).toBeDefined()
  })
})
