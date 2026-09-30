import { describe, it, expect } from 'vitest'
import { groupSkips, formatSkips, SKIP_IDS_SHOWN, type SkippedFix } from '../src/render.js'

/**
 * What `--apply` prints about the fixes it declined (issue #84).
 *
 * One line per skipped issue, each carrying the reason in full. The reason is a
 * property of the *rule* rather than of the issue, so a rule that declines a
 * whole check repeated itself once per issue: a posture check on a project with
 * 47 tables lacking RLS printed the same 150-character sentence 47 times, and
 * the result of the apply scrolled off the top.
 */
const POSTURE_REASON =
  'Posture finding about the target, not drift from the source — applying it '
  + 'would create drift. Use --apply-posture to apply anyway.'

/** `n` posture skips, as `planWork` produces them for a table-per-issue check. */
function postureSkips(n: number, check = 'rls-coverage'): SkippedFix[] {
  return Array.from({ length: n }, (_, i) => ({
    check,
    issueId: `${check}-public-table_${i + 1}`,
    reason: POSTURE_REASON,
  }))
}

describe('groupSkips', () => {
  it('collapses a shared reason into one group', () => {
    const groups = groupSkips(postureSkips(47))

    expect(groups).toHaveLength(1)
    expect(groups[0].issueIds).toHaveLength(47)
    expect(groups[0].reason).toBe(POSTURE_REASON)
  })

  it('keeps different reasons apart within one check', () => {
    // A check can decline issues for different reasons, and merging those
    // would say the wrong thing about most of them.
    const groups = groupSkips([
      ...postureSkips(2, 'vault'),
      { check: 'vault', issueId: 'vault-missing-smtp', reason: 'no SQL fix available' },
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.issueIds.length)).toEqual([2, 1])
  })

  it('keeps the same reason from two checks apart', () => {
    const groups = groupSkips([...postureSkips(2, 'rls-coverage'), ...postureSkips(3, 'auth')])

    expect(groups.map(g => g.check)).toEqual(['rls-coverage', 'auth'])
  })

  it('preserves the order the fixes were planned in', () => {
    const groups = groupSkips([
      { check: 'b', issueId: 'b1', reason: 'r' },
      { check: 'a', issueId: 'a1', reason: 'r' },
      { check: 'b', issueId: 'b2', reason: 'r' },
    ])

    expect(groups.map(g => g.check)).toEqual(['b', 'a'])
    expect(groups[0].issueIds).toEqual(['b1', 'b2'])
  })

  it('is empty for no skips', () => {
    expect(groupSkips([])).toEqual([])
  })
})

describe('formatSkips', () => {
  it('states the long reason once, not once per table', () => {
    const lines = formatSkips(postureSkips(47))

    expect(lines.filter(l => l.includes('--apply-posture'))).toHaveLength(1)
  })

  it('is two lines for 47 issues, where it was 47', () => {
    // The whole of #84.
    expect(formatSkips(postureSkips(47))).toHaveLength(2)
  })

  it('still says how many were skipped', () => {
    // Collapsing must not lose the count: it is what tells you the apply did
    // less than the report asked for.
    expect(formatSkips(postureSkips(47))[0]).toContain('47 issues')
  })

  it('names some of them, and admits to the rest', () => {
    const lines = formatSkips(postureSkips(47))

    expect(lines[1]).toContain('public-table_1')
    expect(lines[1]).toContain(`…and ${47 - SKIP_IDS_SHOWN} more`)
  })

  it('does not repeat the check name on every id', () => {
    // It is already in brackets on the line above, and repeating it 6 times
    // pushed the list past terminal width for no information.
    const lines = formatSkips(postureSkips(47))

    expect(lines[0]).toContain('[rls-coverage]')
    expect(lines[1]).not.toContain('rls-coverage')
  })

  it('keeps an id that only resembles the check name', () => {
    const lines = formatSkips([
      { check: 'rls', issueId: 'rls-coverage-a', reason: 'r' },
      { check: 'rls', issueId: 'rlsx-b', reason: 'r' },
    ])

    // `rls-` is a prefix of the first and not of the second.
    expect(lines[1]).toBe('    coverage-a, rlsx-b')
  })

  it('names them all when they fit', () => {
    const lines = formatSkips(postureSkips(SKIP_IDS_SHOWN))

    expect(lines[1]).not.toContain('more')
    expect(lines[1]).toContain(`table_${SKIP_IDS_SHOWN}`)
  })

  it('leaves a single skip reading exactly as it did', () => {
    // The common case — one issue with its own reason — is not repetitive and
    // gains nothing from being grouped.
    const lines = formatSkips([
      { check: 'vault', issueId: 'vault-missing-smtp', reason: 'create it by hand' },
    ])

    expect(lines).toEqual(['○ [vault] vault-missing-smtp: create it by hand'])
  })

  it('mixes a collapsed group and a lone skip', () => {
    const lines = formatSkips([
      ...postureSkips(10),
      { check: 'vault', issueId: 'vault-missing-smtp', reason: 'create it by hand' },
    ])

    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('○ [vault] vault-missing-smtp: create it by hand')
  })

  it('is empty for no skips', () => {
    expect(formatSkips([])).toEqual([])
  })
})
