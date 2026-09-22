import { describe, it, expect, vi } from 'vitest'
import { inertApplyFlags } from '../src/commands/diff.js'
import { sourceLooksLikeCloneOf } from '../src/branch.js'

/**
 * Five flags did nothing, and said nothing, without `--apply` — the run printed
 * output byte-identical to one with no flag at all (issue #71).
 *
 * The two that matter most are the safety flags. Reaching for `--dry-run` or
 * `--prove` on their own is the natural instinct for "don't actually do it", and
 * both used to answer with an ordinary diff.
 */
describe('inertApplyFlags (issue #71)', () => {
  const names = (flags: Record<string, unknown>) => inertApplyFlags(flags).map(f => f.flag)

  it('reports each apply-only flag passed without --apply', () => {
    expect(names({ prove: true })).toEqual(['prove'])
    expect(names({ 'no-transaction': true })).toEqual(['no-transaction'])
    expect(names({ only: ['schema-alter-3'] })).toEqual(['only'])
    expect(names({ 'apply-posture': true })).toEqual(['apply-posture'])
    expect(names({ 'allow-destructive': true })).toEqual(['allow-destructive'])
  })

  it('reports nothing when --apply is present', () => {
    expect(names({
      apply: true, prove: true, only: ['x'],
      'no-transaction': true, 'apply-posture': true, 'allow-destructive': true,
    })).toEqual([])
  })

  it('reports nothing when no apply-only flag was passed', () => {
    expect(names({ detail: true, check: 'schema', json: true })).toEqual([])
  })

  /**
   * `--dry-run` now selects the planning path by itself, so the flags that shape
   * the plan take effect under it and must not be reported as inert. The ones
   * that only affect *execution* still are.
   */
  it('honours plan-shaping flags under a bare --dry-run', () => {
    expect(names({ 'dry-run': true, only: ['x'] })).toEqual([])
    expect(names({ 'dry-run': true, 'apply-posture': true })).toEqual([])
    expect(names({ 'dry-run': true, 'allow-destructive': true })).toEqual([])
  })

  it('still reports execution-only flags under --dry-run', () => {
    expect(names({ 'dry-run': true, 'no-transaction': true })).toEqual(['no-transaction'])
    expect(names({ 'dry-run': true, prove: true })).toEqual(['prove'])
  })

  it('never reports --dry-run itself as inert', () => {
    expect(names({ 'dry-run': true })).toEqual([])
  })

  it('treats an empty repeatable flag as not passed', () => {
    // oclif gives `[]` rather than undefined in some parse paths; warning then
    // would fire on a flag nobody typed.
    expect(names({ only: [] })).toEqual([])
  })

  it('suggests --dry-run only for flags a dry run would honour', () => {
    const forFlag = (f: string) => inertApplyFlags({ [f]: true })[0]
    expect(forFlag('apply-posture').shapesThePlan).toBe(true)
    expect(forFlag('prove').shapesThePlan).toBe(false)
  })
})

/**
 * The post-diff advice recommended `--apply` in every direction, including the
 * one where it reshapes a shared remote to match a vanilla-PostgreSQL clone —
 * 227 of 601 findings on the diff that prompted this were roles and grants the
 * clone never had (issue #71).
 *
 * Detection used to rest solely on a gitignored local manifest keyed by exact
 * database name, so a clone diffed from another directory read as an ordinary
 * environment. This asks the databases instead.
 */
describe('sourceLooksLikeCloneOf (issue #71)', () => {
  const schemata = (n: number) => [{ n }]

  it('is true when the target has Supabase schemas and the source has none', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce(schemata(0))   // source: vanilla PostgreSQL
      .mockResolvedValueOnce(schemata(2))   // target: auth + storage
    await expect(sourceLooksLikeCloneOf('postgres://s/db', 'postgres://t/db', queryFn)).resolves.toBe(true)
  })

  it('is false between two Supabase environments', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce(schemata(2))
      .mockResolvedValueOnce(schemata(2))
    await expect(sourceLooksLikeCloneOf('postgres://s/db', 'postgres://t/db', queryFn)).resolves.toBe(false)
  })

  it('is false when neither side is Supabase', async () => {
    // Two plain PostgreSQL databases: pushing one onto the other drops nothing
    // Supabase put there, so the warning would be noise.
    const queryFn = vi.fn()
      .mockResolvedValueOnce(schemata(0))
      .mockResolvedValueOnce(schemata(0))
    await expect(sourceLooksLikeCloneOf('postgres://s/db', 'postgres://t/db', queryFn)).resolves.toBe(false)
  })

  it('is false in the safe direction — Supabase source, vanilla target', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce(schemata(2))
      .mockResolvedValueOnce(schemata(0))
    await expect(sourceLooksLikeCloneOf('postgres://s/db', 'postgres://t/db', queryFn)).resolves.toBe(false)
  })

  it('answers false rather than throwing when a database is unreachable', async () => {
    // It only words a hint; a connection failure must not fail the diff.
    const queryFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(sourceLooksLikeCloneOf('postgres://s/db', 'postgres://t/db', queryFn)).resolves.toBe(false)
  })

  it('answers false when either url is missing, without querying', async () => {
    const queryFn = vi.fn()
    await expect(sourceLooksLikeCloneOf(undefined, 'postgres://t/db', queryFn)).resolves.toBe(false)
    await expect(sourceLooksLikeCloneOf('postgres://s/db', undefined, queryFn)).resolves.toBe(false)
    expect(queryFn).not.toHaveBeenCalled()
  })
})
