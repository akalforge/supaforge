import { describe, it, expect } from 'vitest'
import { foldDuplicatePolicyFindings, foldDuplicateExtensionFindings, extensionOnlyKeys } from '../src/scanner.js'
import { policyOnlyKeys } from '../src/sql-deps.js'
import { dropEquivalentPolicyChanges, type PolicyCanonicalizer } from '../src/utils/policy-equivalence.js'
import type { CheckResult, DriftIssue } from '../src/types/drift.js'
import type { CheckContext } from '../src/checks/base.js'

const issue = (check: string, id: string, up: string, extra: Partial<DriftIssue> = {}): DriftIssue =>
  ({ id, check, severity: 'warning', title: id, description: '', sql: { up, down: '' }, ...extra } as DriftIssue)

describe('policyOnlyKeys', () => {
  it('keys a fix made only of policy statements', () => {
    expect(policyOnlyKeys('DROP POLICY IF EXISTS "own" ON "orders";\nCREATE POLICY "own" ON "orders" USING (true);'))
      .toEqual(['public.orders.own'])
  })
  it('keys a policy with its schema, public where none is named', () => {
    expect(policyOnlyKeys('CREATE POLICY "own" ON "app"."orders" USING (true);\nDROP POLICY "own" ON orders;'))
      .toEqual(['app.orders.own', 'public.orders.own'])
  })
  it('is null for anything else in the fix', () => {
    expect(policyOnlyKeys('CREATE TABLE t (id int);\nCREATE POLICY p ON t USING (true);')).toBeNull()
    expect(policyOnlyKeys(undefined)).toBeNull()
  })
})

describe('foldDuplicatePolicyFindings (issue #97)', () => {
  const rls = (issues: DriftIssue[]): CheckResult => ({ check: 'rls', status: 'drifted', issues, durationMs: 1 })
  const schema = (issues: DriftIssue[]): CheckResult => ({ check: 'schema', status: 'drifted', issues, durationMs: 1 })
  const rlsMissing = issue('rls', 'rls-missing-public.orders.own',
    'CREATE POLICY "own" ON "public"."orders" USING (true);', { sourceValue: { schemaname: 'public' } })

  it('keeps the RLS finding and folds the schema check\'s copy of it', () => {
    const results = [schema([issue('schema', 'schema-change-1', 'CREATE POLICY "own" ON "orders" USING (true);')]), rls([rlsMissing])]
    foldDuplicatePolicyFindings(results)

    expect(results[0].issues).toEqual([])
    expect(results[0].status).toBe('clean')
    expect(results[0].folded).toEqual([{ count: 1, into: 'rls' }])
    expect(results[1].issues).toHaveLength(1)
  })

  it('keeps a schema finding that does more than the policy', () => {
    const results = [schema([issue('schema', 's', 'CREATE TABLE orders (id int);\nCREATE POLICY "own" ON "orders" USING (true);')]), rls([rlsMissing])]
    foldDuplicatePolicyFindings(results)
    expect(results[0].issues).toHaveLength(1)
    expect(results[0].folded).toBeUndefined()
  })

  it('does not fold into a same-named policy in another schema', () => {
    const storage = issue('rls', 'rls-missing-storage.orders.own',
      'CREATE POLICY "own" ON "storage"."orders" USING (true);', { sourceValue: { schemaname: 'storage' } })
    const results = [schema([issue('schema', 's', 'CREATE POLICY "own" ON "orders" USING (true);')]), rls([storage])]
    foldDuplicatePolicyFindings(results)
    expect(results[0].issues).toHaveLength(1)
  })

  it('folds nothing when the RLS check did not run', () => {
    const results = [schema([issue('schema', 's', 'CREATE POLICY "own" ON "orders" USING (true);')]),
      { check: 'rls', status: 'skipped', issues: [], durationMs: 0 } as CheckResult]
    foldDuplicatePolicyFindings(results)
    expect(results[0].issues).toHaveLength(1)
  })
})

describe('foldDuplicateExtensionFindings', () => {
  const result = (check: CheckResult['check'], issues: DriftIssue[]): CheckResult => ({ check, status: 'drifted', issues, durationMs: 1 })
  const missing = issue('extensions', 'ext-missing-btree_gist', 'CREATE EXTENSION IF NOT EXISTS "btree_gist";')

  it('keys a fix that only creates or drops extensions', () => {
    expect(extensionOnlyKeys('CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";')).toEqual(['btree_gist'])
    expect(extensionOnlyKeys('DROP EXTENSION IF EXISTS "uuid-ossp";')).toEqual(['uuid-ossp'])
    expect(extensionOnlyKeys('CREATE EXTENSION x; CREATE TABLE t (id int);')).toBeNull()
    expect(extensionOnlyKeys(undefined)).toBeNull()
  })

  // @dbdiff/cli creates the extensions of the schemas it compares (rc.22); the
  // extensions check reports the same one, with what the server can offer.
  it('keeps the extensions check finding and folds the schema copy', () => {
    const results = [
      result('schema', [issue('schema', 's1', 'CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";')]),
      result('extensions', [missing]),
    ]
    foldDuplicateExtensionFindings(results)
    expect(results[0].issues).toEqual([])
    expect(results[0].folded).toEqual([{ count: 1, into: 'extensions' }])
  })

  // The extensions check offers no fix for an extra extension: the schema
  // check's DROP EXTENSION is the only one, and stays.
  it('keeps a schema finding the extensions check offers no fix for', () => {
    const extra = issue('extensions', 'ext-extra-btree_gist', '', { sql: undefined })
    const results = [result('schema', [issue('schema', 's1', 'DROP EXTENSION IF EXISTS "btree_gist";')]), result('extensions', [extra])]
    foldDuplicateExtensionFindings(results)
    expect(results[0].issues).toHaveLength(1)
  })

  it('records a fold into each check that has one', () => {
    const results = [
      result('schema', [
        issue('schema', 's1', 'CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";'),
        issue('schema', 's2', 'CREATE POLICY "own" ON "orders" USING (true);'),
      ]),
      result('extensions', [missing]),
      result('rls', [issue('rls', 'r1', 'CREATE POLICY "own" ON "public"."orders" USING (true);')]),
    ]
    foldDuplicatePolicyFindings(results)
    foldDuplicateExtensionFindings(results)
    expect(results[0].folded).toEqual([{ count: 1, into: 'rls' }, { count: 1, into: 'extensions' }])
  })
})

describe('dropEquivalentPolicyChanges', () => {
  const ctx = { source: { dbUrl: 'src' }, target: { dbUrl: 'tgt' } } as unknown as CheckContext
  const policy = (qual: string) => ({
    schemaname: 'public', tablename: 'docs', policyname: 'vis', permissive: 'PERMISSIVE',
    cmd: 'ALL', roles: ['public'], qual, with_check: null,
  })
  const modified = (a: string, b: string) =>
    issue('rls', 'rls-modified-public.docs.vis', 'x', { sourceValue: policy(a), targetValue: policy(b) })
  const same: PolicyCanonicalizer = async () => ({ qual: 'stable', with_check: null })
  const echo: PolicyCanonicalizer = async (_url, p) => ({ qual: p.qual, with_check: p.with_check })

  it('drops a change whose two sides re-render the same', async () => {
    expect(await dropEquivalentPolicyChanges([modified('written', 'rendered')], ctx, same)).toEqual([])
  })

  it('keeps a change whose sides still differ once re-rendered', async () => {
    expect(await dropEquivalentPolicyChanges([modified('a', 'b')], ctx, echo)).toHaveLength(1)
  })

  it('keeps it when either side cannot be re-rendered', async () => {
    expect(await dropEquivalentPolicyChanges([modified('a', 'b')], ctx, async () => null)).toHaveLength(1)
  })

  it('never looks past a difference in command or roles', async () => {
    const other = issue('rls', 'x', 'x', {
      sourceValue: { ...policy('a'), cmd: 'SELECT' }, targetValue: policy('b'),
    })
    expect(await dropEquivalentPolicyChanges([other], ctx, same)).toHaveLength(1)
  })

  it('takes the schema from the check when rows do not carry it', async () => {
    const { schemaname: _drop, ...row } = policy('a')
    const seen: string[] = []
    const record: PolicyCanonicalizer = async (_url, p) => { seen.push(p.schemaname); return { qual: 's', with_check: null } }
    await dropEquivalentPolicyChanges(
      [issue('storage', 'x', 'x', { sourceValue: row, targetValue: { ...row, qual: 'b' } })], ctx, record, 'storage')
    expect(seen).toEqual(['storage', 'storage'])
  })
})
