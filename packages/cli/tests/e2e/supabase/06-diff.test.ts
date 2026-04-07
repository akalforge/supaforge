/**
 * E2E: Detailed diff output across all testable checks.
 *
 * Tests that scan() + renderDetailed() produces meaningful output
 * covering multiple checks. This validates the `supaforge diff` command flow.
 *
 * Runs after individual check promotes have occurred, so some drift
 * may already be resolved. The test focuses on structure, not specific counts.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { createDefaultRegistry } from '../../../src/checks/index'
import { renderDetailed } from '../../../src/render'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult, CheckName } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

/** All DB-only checks testable in a local Supabase E2E. */
const ALL_DB_CHECKS: CheckName[] = [
  'rls', 'cron', 'webhooks', 'storage',
  'realtime', 'vault', 'extensions',
]

describe('e2e: diff command flow', () => {
  let config: SupaForgeConfig
  let result: ScanResult
  let detailed: string

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig()

    const registry = createDefaultRegistry()
    result = await scan(registry, { config, checks: ALL_DB_CHECKS })
    detailed = renderDetailed(result)
  })

  it.skipIf(shouldSkip())('should scan all checks without errors', () => {
    const errorChecks = result.checks.filter(l => l.status === 'error')
    expect(errorChecks, `Error checks: ${JSON.stringify(errorChecks)}`).toHaveLength(0)
  })

  it.skipIf(shouldSkip())('should return results for every requested check', () => {
    const returnedChecks = result.checks.map(l => l.check)
    for (const check of ALL_DB_CHECKS) {
      expect(returnedChecks).toContain(check)
    }
  })

  it.skipIf(shouldSkip())('should produce a valid ScanResult structure', () => {
    expect(result.timestamp).toBeDefined()
    expect(result.source).toBeDefined()
    expect(result.target).toBeDefined()
    expect(typeof result.score).toBe('number')
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.summary.total).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(shouldSkip())('should produce non-empty detailed output', () => {
    expect(detailed).toBeDefined()
    expect(detailed.length).toBeGreaterThan(0)
  })

  it.skipIf(shouldSkip())('should include check names in detailed output', () => {
    // renderDetailed should mention the check names
    expect(detailed.toLowerCase()).toMatch(/rls|cron|webhook|storage|realtime|vault|extension/)
  })

  it.skipIf(shouldSkip())('each check should have valid timing', () => {
    for (const check of result.checks) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0)
      expect(check.durationMs).toBeLessThan(30_000) // Should complete within 30s per check
    }
  })

  it.skipIf(shouldSkip())('each issue should have required fields', () => {
    const allIssues = result.checks.flatMap(l => l.issues)
    for (const issue of allIssues) {
      expect(issue.id).toBeDefined()
      expect(issue.check).toBeDefined()
      expect(issue.severity).toMatch(/^(critical|warning|info)$/)
      expect(issue.title).toBeDefined()
      expect(issue.description).toBeDefined()
    }
  })

  it.skipIf(shouldSkip())('single-check scan should work', async () => {
    const registry = createDefaultRegistry()
    const single = await scan(registry, { config, checks: ['rls'] })
    expect(single.checks).toHaveLength(1)
    expect(single.checks[0].check).toBe('rls')
  })
})
