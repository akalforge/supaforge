/**
 * E2E: Storage drift detection and promotion (real Storage API + policies).
 *
 * Tests against real Supabase instances with:
 *   - Bucket visibility mismatch: avatars (public vs private)
 *   - Missing bucket: documents
 *   - Extra bucket: backups
 *   - Missing storage policy: avatars_insert on storage.objects
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: storage layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['storage'] })
  })

  it.skipIf(shouldSkip())('should detect storage drift', () => {
    const storage = initialScan.checks.find(l => l.check === 'storage')!
    expect(storage.status).toBe('drifted')
    expect(storage.issues.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(shouldSkip())('should detect missing documents bucket', () => {
    const storage = initialScan.checks.find(l => l.check === 'storage')!
    const missing = storage.issues.find(i => i.id.includes('storage-missing-documents'))
    expect(missing).toBeDefined()
    expect(missing!.title).toContain('Missing bucket')
    // Should have API sync action (POST)
    expect(missing!.action).toBeDefined()
    expect(missing!.action!.method).toBe('POST')
    expect(missing!.action!.url).toContain('/storage/v1/bucket')
  })

  it.skipIf(shouldSkip())('should detect extra backups bucket', () => {
    const storage = initialScan.checks.find(l => l.check === 'storage')!
    const extra = storage.issues.find(i => i.id.includes('storage-extra-backups'))
    expect(extra).toBeDefined()
    expect(extra!.title).toContain('Extra bucket')
    expect(extra!.action).toBeDefined()
    expect(extra!.action!.method).toBe('DELETE')
  })

  it.skipIf(shouldSkip())('should detect avatars visibility mismatch', () => {
    const storage = initialScan.checks.find(l => l.check === 'storage')!
    const visibility = storage.issues.find(i => i.id.includes('storage-visibility-avatars'))
    expect(visibility).toBeDefined()
    expect(visibility!.title).toContain('visibility mismatch')
  })

  it.skipIf(shouldSkip())('should detect missing storage policy', () => {
    const storage = initialScan.checks.find(l => l.check === 'storage')!
    // Storage policies are RLS on storage.objects — the storage check diffs them
    const missingPolicy = storage.issues.find(i =>
      i.id.includes('avatars_insert') && i.sql?.up,
    )
    expect(missingPolicy).toBeDefined()
    expect(missingPolicy!.sql!.up).toContain('CREATE POLICY')
  })

  it.skipIf(shouldSkip())('should promote storage fixes via API and SQL', async () => {
    const targetApiUrl = process.env.SUPAFORGE_E2E_TARGET_API_URL!
    const targetServiceKey = process.env.SUPAFORGE_E2E_TARGET_SERVICE_KEY!

    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['storage'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: bucket + policy drift should be reduced
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['storage'] })
    const storageResult = rescan.checks.find(l => l.check === 'storage')!

    // Missing documents bucket should be created
    const missingDocs = storageResult.issues.find(i => i.id.includes('storage-missing-documents'))
    expect(missingDocs).toBeUndefined()

    // Missing avatars_insert policy should be created
    const missingPolicy = storageResult.issues.find(i =>
      i.id.includes('avatars_insert') && i.severity === 'critical',
    )
    expect(missingPolicy).toBeUndefined()
  })
})
