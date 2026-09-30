import { describe, it, expect } from 'vitest'
import { groupColumnTypeChanges, sqlToIssues, destructiveReason } from '../src/dbdiff.js'
import { planWork } from '../src/promote.js'
import { orderStatements, statementPhase, PHASE } from '../src/sql-deps.js'
import type { ScanResult, DriftIssue } from '../src/types/drift.js'

/**
 * @dbdiff/cli brackets a column type change with the views, policies and
 * triggers PostgreSQL will not let it retype under: drop them, retype,
 * recreate them. Split one statement per issue, that bracket came apart —
 * the DROP POLICY was held back by the destructive gate, the ALTER then
 * failed, and two changes under one view each tried to CREATE it.
 */

// What @dbdiff/cli emits for `orders.user_id text → uuid` with a view and a
// policy on the column, where the policy's definition changes too.
const BRACKET = [
  'DROP POLICY IF EXISTS "own" ON "orders";',
  'DROP VIEW IF EXISTS "paid_orders";',
  'ALTER TABLE "orders" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;',
  'CREATE VIEW "paid_orders" WITH (security_invoker=true) AS SELECT id, user_id FROM orders;',
  'REVOKE ALL ON "paid_orders" FROM anon, authenticated;',
  'GRANT ALL ON "paid_orders" TO CURRENT_USER;',
  'GRANT SELECT ON "paid_orders" TO authenticated;',
  `COMMENT ON VIEW "paid_orders" IS 'paid';`,
]
const POLICY_CHANGE = [
  'DROP POLICY IF EXISTS "own" ON "orders";',
  `CREATE POLICY "own" ON "orders" FOR ALL USING ((user_id = (current_setting('app.uid'::text, true))::uuid));`,
]

describe('groupColumnTypeChanges', () => {
  it('keeps a bracket together as one statement', () => {
    const out = groupColumnTypeChanges(['ALTER TABLE "x" ADD COLUMN "y" int;', ...BRACKET, ...POLICY_CHANGE])

    expect(out).toHaveLength(4)
    expect(out[0]).toBe('ALTER TABLE "x" ADD COLUMN "y" int;')
    expect(out[1]).toBe(BRACKET.join('\n'))
    expect(out.slice(2)).toEqual(POLICY_CHANGE)
  })

  it('leaves a type change with nothing around it exactly as it was', () => {
    const plain = ['ALTER TABLE "t" ALTER COLUMN "a" TYPE bigint;', 'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;']
    expect(groupColumnTypeChanges(plain)).toEqual(plain)
  })

  it('takes the rest of the same column\'s change, and a matview\'s indexes and triggers', () => {
    const out = groupColumnTypeChanges([
      'DROP MATERIALIZED VIEW IF EXISTS "totals";',
      'DROP TRIGGER IF EXISTS "big" ON "orders";',
      'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE numeric(12,2);',
      'ALTER TABLE "orders" ALTER COLUMN "amount" SET DEFAULT 0;',
      'CREATE MATERIALIZED VIEW "totals" AS SELECT sum(amount) AS s FROM orders;',
      'CREATE INDEX totals_s ON public.totals USING btree (s);',
      'CREATE TRIGGER big BEFORE UPDATE ON public.orders FOR EACH ROW WHEN ((new.amount > (100)::numeric)) EXECUTE FUNCTION f();',
      'ALTER TABLE "orders" ALTER COLUMN "note" SET DEFAULT \'x\';',
    ])
    expect(out).toHaveLength(2)
    expect(out[1]).toBe('ALTER TABLE "orders" ALTER COLUMN "note" SET DEFAULT \'x\';')
  })

  it('does not swallow an unrelated policy removal that happens to sit before it', () => {
    // A policy on another table, dropped by the source and not put back: it
    // is a genuine removal and must stay its own, gated, issue.
    const out = groupColumnTypeChanges([
      'DROP POLICY IF EXISTS "legacy" ON "invoices";',
      'DROP VIEW IF EXISTS "v";',
      'ALTER TABLE "orders" ALTER COLUMN "a" TYPE bigint;',
      'CREATE VIEW "v" AS SELECT a FROM orders;',
    ])
    expect(out[0]).toBe('DROP POLICY IF EXISTS "legacy" ON "invoices";')
    expect(out[1].startsWith('DROP VIEW IF EXISTS "v";')).toBe(true)
  })

  it('handles views in other schemas', () => {
    const out = groupColumnTypeChanges([
      'DROP VIEW IF EXISTS "api"."v";',
      'ALTER TABLE "orders" ALTER COLUMN "a" TYPE bigint;',
      'CREATE VIEW "api"."v" AS SELECT a FROM orders;',
    ])
    expect(out).toHaveLength(1)
  })
})

describe('sqlToIssues with a bracket', () => {
  const issues = sqlToIssues({ up: [...BRACKET, ...POLICY_CHANGE].join('\n'), down: '' }, 'schema')

  it('reports one change, titled by its ALTER', () => {
    expect(issues).toHaveLength(2)
    expect(issues[0].title).toMatch(/orders/)
    expect(issues[0].title).not.toMatch(/Extra view|Extra policy/)
  })

  it('reports a changed policy as one modification, not a removal and an addition', () => {
    expect(issues[1].title).toBe('Policy modified: public.orders.own')
    expect(issues[1].sql!.up).toBe(POLICY_CHANGE.join('\n'))
  })

  it('runs the bracket in the column-change phase', () => {
    expect(statementPhase(issues[0].sql!.up)).toBe(PHASE.ALTER_TABLE)
  })
})

describe('the destructive gate across the fixes of one apply', () => {
  function scan(issues: DriftIssue[]): ScanResult {
    return {
      timestamp: '', source: 's', target: 't', score: 0,
      checks: [{ check: 'schema', status: 'drifted', issues, durationMs: 1 }],
    } as unknown as ScanResult
  }
  const issue = (id: string, up: string): DriftIssue =>
    ({ id, check: 'schema', severity: 'warning', title: id, description: '', sql: { up, down: '' } })

  it('lets a column change drop a policy another fix recreates', () => {
    const plan = planWork(scan([issue('column', BRACKET.join('\n')), issue('policy', POLICY_CHANGE.join('\n'))]))

    expect(plan.skipped).toEqual([])
    expect(plan.sqlStatements.map(s => s.issueId)).toEqual(['column', 'policy'])
  })

  it('still gates it when the recreating fix is not selected', () => {
    const plan = planWork(scan([issue('column', BRACKET.join('\n')), issue('policy', POLICY_CHANGE.join('\n'))]),
      { only: ['column'] })

    expect(plan.sqlStatements).toEqual([])
    expect(plan.skipped.find(s => s.issueId === 'column')?.reason).toMatch(/removes the policy orders\.own/)
  })

  it('does not count a posture fix, which does not run by default, as putting it back', () => {
    const result = planWork({
      timestamp: '', source: 's', target: 't', score: 0,
      checks: [
        { check: 'schema', status: 'drifted', durationMs: 1, issues: [issue('column', BRACKET.join('\n'))] },
        { check: 'rls-coverage', status: 'drifted', durationMs: 1, issues: [issue('posture', POLICY_CHANGE[1])] },
      ],
    } as unknown as ScanResult)

    expect(result.skipped.find(s => s.issueId === 'column')?.reason).toMatch(/removes the policy/)
  })

  it('still gates a policy nothing puts back', () => {
    expect(destructiveReason('DROP POLICY IF EXISTS "own" ON "orders";')).toMatch(/removes the policy/)
    expect(destructiveReason('DROP POLICY IF EXISTS "own" ON "orders";', new Set(['orders.own']))).toBeUndefined()
  })
})

describe('orderStatements with brackets', () => {
  it('does not treat a policy the bracket drops as one it needs', () => {
    // The policy fix creates "own", and the bracket mentions "own" only to
    // drop it. Ordered after it, the new definition met the old column type.
    const ordered = orderStatements([POLICY_CHANGE.join('\n'), BRACKET.join('\n')], s => s)
    expect(ordered[0]).toBe(BRACKET.join('\n'))
  })

  it('runs two brackets under one view by phase, not by a cycle', () => {
    const second = BRACKET.join('\n').replace(/"user_id" TYPE uuid USING "user_id"::uuid/, '"amount" TYPE numeric(12,2)')
      .replace('DROP POLICY IF EXISTS "own" ON "orders";\n', '')
    const ordered = orderStatements([POLICY_CHANGE.join('\n'), BRACKET.join('\n'), second], s => s)
    expect(ordered[2]).toBe(POLICY_CHANGE.join('\n'))
  })
})
