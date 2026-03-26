import { describe, it, expect } from 'vitest'
import { promote } from '../src/promote.js'
import type { ScanResult } from '../src/types/drift.js'

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    source: 'dev',
    target: 'prod',
    layers: [],
    score: 100,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    ...overrides,
  }
}

describe('promote', () => {
  it('returns empty result when no drift', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScanResult(),
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('collects SQL statements in dry-run mode', async () => {
    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-public.users.read_policy',
              layer: 'rls',
              severity: 'critical',
              title: 'Missing RLS policy',
              description: 'Policy missing in target',
              sql: {
                up: 'CREATE POLICY "read_policy" ON "public"."users" AS PERMISSIVE FOR SELECT TO authenticated USING (true);',
                down: 'DROP POLICY IF EXISTS "read_policy" ON "public"."users";',
              },
            },
          ],
          durationMs: 50,
        },
      ],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].layer).toBe('rls')
    expect(result.applied[0].sql).toContain('CREATE POLICY')
    expect(result.errors).toHaveLength(0)
  })

  it('skips issues without SQL fix', async () => {
    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'auth',
          status: 'drifted',
          issues: [
            {
              id: 'auth-jwt_exp',
              layer: 'auth',
              severity: 'critical',
              title: 'Auth config mismatch: JWT_EXP',
              description: 'JWT_EXP differs',
              // No sql field
            },
          ],
          durationMs: 50,
        },
      ],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('No SQL fix')
  })

  it('filters by specific layers', async () => {
    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-1',
              layer: 'rls',
              severity: 'critical',
              title: 'Missing RLS',
              description: 'desc',
              sql: { up: 'CREATE POLICY ...;', down: 'DROP POLICY ...;' },
            },
          ],
          durationMs: 10,
        },
        {
          layer: 'cron',
          status: 'drifted',
          issues: [
            {
              id: 'cron-missing-1',
              layer: 'cron',
              severity: 'warning',
              title: 'Missing cron',
              description: 'desc',
              sql: { up: "SELECT cron.schedule('x','y',$$ z $$);", down: "SELECT cron.unschedule('x');" },
            },
          ],
          durationMs: 10,
        },
      ],
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      layers: ['rls'],
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].layer).toBe('rls')
  })

  it('skips clean layers', async () => {
    const scanResult = makeScanResult({
      layers: [
        {
          layer: 'rls',
          status: 'clean',
          issues: [],
          durationMs: 10,
        },
      ],
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
  })
})
