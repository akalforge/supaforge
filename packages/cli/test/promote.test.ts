import { describe, it, expect } from 'vitest'
import { promote, planWork, outOfScopeReason } from '../src/promote.js'
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

/**
 * The fix set @dbdiff/cli produced for issue #48's two databases, scoped to
 * `--tables=users`. dbdiff's `--tables` filters tables only, so the view and
 * trigger belonging to the excluded `orders` survive into the fix set while the
 * column they need does not.
 */
function makeScopedScanResult(): ScanResult {
  return makeScanResult({
    checks: [
      {
        check: 'schema',
        status: 'drifted',
        durationMs: 10,
        issues: [
          {
            id: 'schema-alter-1',
            check: 'schema',
            severity: 'warning',
            title: 'Table altered: users',
            description: 'x',
            sql: { up: 'ALTER TABLE "users" ADD COLUMN "created_at" timestamptz(6);', down: '' },
          },
          {
            id: 'schema-create-view-2',
            check: 'schema',
            severity: 'warning',
            title: 'View missing: active_orders',
            description: 'x',
            sql: { up: `CREATE VIEW "active_orders" AS SELECT id FROM orders WHERE (status = 'pending');`, down: '' },
          },
          {
            id: 'schema-create-trigger-3',
            check: 'schema',
            severity: 'warning',
            title: 'Trigger missing: trg_orders_touch',
            description: 'x',
            sql: {
              up: 'CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();',
              down: '',
            },
          },
          {
            id: 'schema-create-function-4',
            check: 'schema',
            severity: 'warning',
            title: 'Function missing: public.touch_updated()',
            description: 'x',
            sql: {
              up: 'CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$;',
              down: '',
            },
          },
        ],
      },
    ],
    summary: { total: 4, critical: 0, warning: 4, info: 0 },
  })
}

describe('outOfScopeReason', () => {
  it('returns null when nothing is scoped', () => {
    expect(outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', undefined)).toBeNull()
    expect(outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', {})).toBeNull()
  })

  it('names the excluded table and the flag that excluded it', () => {
    const reason = outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', { tables: ['users'] })
    expect(reason).toBe("Depends on table 'orders', excluded by --tables")
  })

  it('credits --exclude-tables when that is what narrowed the run', () => {
    const reason = outOfScopeReason('CREATE INDEX i ON public.orders (status);', { excludeTables: ['orders'] })
    expect(reason).toBe("Depends on table 'orders', excluded by --exclude-tables")
  })

  it('lets through a fix that only touches tables still in scope', () => {
    expect(outOfScopeReason('ALTER TABLE "users" ADD COLUMN "bio" text;', { tables: ['users'] })).toBeNull()
  })

  it('lets through a fix that touches no table at all', () => {
    const sql = 'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$;'
    expect(outOfScopeReason(sql, { tables: ['users'] })).toBeNull()
  })

  it('honours the globs the filter itself supports', () => {
    expect(outOfScopeReason('CREATE INDEX i ON billing_events (id);', { tables: ['billing_*'] })).toBeNull()
  })
})

describe('planWork ordering', () => {
  it('returns SQL in dependency order, not the order the check reported it', async () => {
    const plan = await planWork(makeScopedScanResult())
    const ids = plan.sqlStatements.map(s => s.issueId)
    expect(ids.indexOf('schema-create-function-4')).toBeLessThan(ids.indexOf('schema-create-trigger-3'))
  })
})

describe('promote scoping', () => {
  it('skips a dependant of an excluded table instead of attempting and failing', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      tableFilter: { tables: ['users'] },
    })

    expect(result.applied.map(a => a.issueId).sort()).toEqual(['schema-alter-1', 'schema-create-function-4'])
    expect(result.errors).toHaveLength(0)

    const skipped = Object.fromEntries(result.skipped.map(s => [s.issueId, s.reason]))
    expect(skipped['schema-create-view-2']).toContain("'orders'")
    expect(skipped['schema-create-trigger-3']).toContain("'orders'")
  })

  it('applies every fix when no table filter is active', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
    })
    expect(result.applied).toHaveLength(4)
    expect(result.skipped).toHaveLength(0)
  })
})

describe('promote --only', () => {
  it('applies exactly the listed issue ids', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: ['schema-alter-1'],
    })

    expect(result.applied.map(a => a.issueId)).toEqual(['schema-alter-1'])
    expect(result.skipped).toHaveLength(3)
    expect(result.skipped[0].reason).toBe('Not selected by --only')
  })

  it('supports globs so a family of fixes can be picked in one go', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: ['schema-create-*'],
    })

    expect(result.applied.map(a => a.issueId).sort()).toEqual([
      'schema-create-function-4',
      'schema-create-trigger-3',
      'schema-create-view-2',
    ])
  })

  it('treats an empty list as no selection at all', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: [],
    })
    expect(result.applied).toHaveLength(4)
  })
})
