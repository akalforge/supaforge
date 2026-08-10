import { describe, it, expect } from 'vitest'
import { promote } from '../src/promote.js'
import type { ScanResult } from '../src/types/drift.js'

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    source: 'dev',
    target: 'prod',
    checks: [],
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
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-public.users.read_policy',
              check: 'rls',
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
    expect(result.applied[0].check).toBe('rls')
    expect(result.applied[0].sql).toContain('CREATE POLICY')
    expect(result.errors).toHaveLength(0)
  })

  it('skips issues without SQL fix', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'auth',
          status: 'drifted',
          issues: [
            {
              id: 'auth-jwt_exp',
              check: 'auth',
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

  it('filters by specific checks', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-1',
              check: 'rls',
              severity: 'critical',
              title: 'Missing RLS',
              description: 'desc',
              sql: { up: 'CREATE POLICY ...;', down: 'DROP POLICY ...;' },
            },
          ],
          durationMs: 10,
        },
        {
          check: 'cron',
          status: 'drifted',
          issues: [
            {
              id: 'cron-missing-1',
              check: 'cron',
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
      checks: ['rls'],
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].check).toBe('rls')
  })

  it('skips destructive statements unless allowDestructive is set', async () => {
    // @dbdiff/cli now returns these (SupaForge passes --allow-destructive so
    // drift is *reported*), so the safety gate has to live here at apply time.
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'schema',
          status: 'drifted',
          durationMs: 10,
          issues: [
            {
              id: 'schema-drop-1',
              check: 'schema',
              severity: 'critical',
              title: 'Extra table: stale',
              description: 'x',
              sql: { up: 'DROP TABLE "stale";', down: '' },
            },
            {
              id: 'schema-alter-1',
              check: 'schema',
              severity: 'warning',
              title: 'Table altered: users',
              description: 'x',
              sql: { up: 'ALTER TABLE "users" ADD COLUMN "bio" text;', down: '' },
            },
          ],
        },
      ],
    })

    const guarded = await promote({ dbUrl: 'postgres://unused', scanResult, dryRun: true })
    expect(guarded.applied).toHaveLength(1)
    expect(guarded.applied[0].issueId).toBe('schema-alter-1')
    expect(guarded.skipped).toHaveLength(1)
    expect(guarded.skipped[0].issueId).toBe('schema-drop-1')
    expect(guarded.skipped[0].reason).toContain('--allow-destructive')

    const opted = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
      allowDestructive: true,
    })
    expect(opted.applied).toHaveLength(2)
    expect(opted.skipped).toHaveLength(0)
  })

  it('skips clean checks', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'rls',
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
