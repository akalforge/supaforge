/**
 * E2E: Vault secret drift detection and promotion.
 *
 * Tests against real Supabase instances with:
 *   - Missing secret: smtp_password (source has api_key + smtp_password, target only has api_key)
 *
 * Note: Vault secrets cannot be auto-synced (the plaintext value is not transferable).
 * Promote creates a PLACEHOLDER secret. After promote, the missing issue resolves
 * but a "modified" INFO issue may appear (different encrypted values).
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
    const vault = initialScan.checks.find(l => l.check === 'vault')!

    const missing = vault.issues.find(i => i.id.includes('smtp_password') && i.title.includes('Missing'))
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.title).toContain('smtp_password')
    expect(missing!.sql?.up).toContain('vault.create_secret')
    expect(missing!.sql?.up).toContain('PLACEHOLDER_VALUE')
  })

  it.skipIf(shouldSkip())('should not flag api_key as missing (exists in both)', () => {
    const vault = initialScan.checks.find(l => l.check === 'vault')!

    const apiKeyMissing = vault.issues.find(
      i => i.id.includes('api_key') && i.title.includes('Missing'),
    )
    expect(apiKeyMissing).toBeUndefined()
  })

  it.skipIf(shouldSkip())('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['vault'],
      dryRun: true,
    })

    const sqlApplied = result.applied.filter(a => a.sql)
    expect(sqlApplied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['vault'] })
    const missingCount = rescan.checks[0].issues.filter(i => i.title.includes('Missing')).length
    expect(missingCount).toBe(initialScan.checks[0].issues.filter(i => i.title.includes('Missing')).length)
  })

  it.skipIf(shouldSkip())('should promote vault fixes and resolve missing secret', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['vault'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: smtp_password should no longer be missing
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['vault'] })
    const vaultResult = rescan.checks.find(l => l.check === 'vault')!

    const missingSMTP = vaultResult.issues.find(
      i => i.id.includes('smtp_password') && i.title.includes('Missing'),
    )
    expect(missingSMTP).toBeUndefined()

    // A "modified" info issue may appear (different encrypted values) — that's expected
    const modifiedSMTP = vaultResult.issues.find(
      i => i.id.includes('smtp_password') && i.title.includes('Modified'),
    )
    if (modifiedSMTP) {
      expect(modifiedSMTP.severity).toBe('info')
    }
  })
})
