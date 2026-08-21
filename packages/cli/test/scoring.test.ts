import { describe, it, expect } from 'vitest'
import { computeScore, computePostureScore, summarize } from '../src/scoring.js'
import { isComparisonCheck, CHECK_NAMES } from '../src/types/drift.js'
import { SCORE_PENALTY_CRITICAL, SCORE_PENALTY_ERROR } from '../src/constants.js'
import type { CheckResult, CheckName, DriftIssue } from '../src/types/drift.js'

const clean: CheckResult = {
  check: 'schema',
  status: 'clean',
  issues: [],
  durationMs: 10,
}

const drifted: CheckResult = {
  check: 'rls',
  status: 'drifted',
  issues: [
    { id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' },
    { id: '2', check: 'rls', severity: 'warning', title: 'Extra policy', description: '' },
  ],
  durationMs: 20,
}

describe('summarize', () => {
  it('returns zeros for clean results', () => {
    expect(summarize([clean])).toEqual({ total: 0, critical: 0, warning: 0, info: 0 })
  })

  it('counts issues by severity', () => {
    expect(summarize([drifted])).toEqual({ total: 2, critical: 1, warning: 1, info: 0 })
  })

  it('aggregates across multiple checks', () => {
    const infoResult: CheckResult = {
      check: 'cron',
      status: 'drifted',
      issues: [{ id: '3', check: 'cron', severity: 'info', title: 'Extra job', description: '' }],
      durationMs: 5,
    }
    expect(summarize([drifted, infoResult])).toEqual({ total: 3, critical: 1, warning: 1, info: 1 })
  })
})

describe('computeScore', () => {
  it('returns 100 for clean results', () => {
    expect(computeScore([clean])).toBe(100)
  })

  it('penalises critical issues heavily', () => {
    const score = computeScore([drifted])
    expect(score).toBe(100 - 15 - 5) // 80
  })

  it('never goes below 0', () => {
    const manyIssues: CheckResult = {
      ...drifted,
      issues: Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        check: 'rls' as const,
        severity: 'critical' as const,
        title: '',
        description: '',
      })),
    }
    expect(computeScore([manyIssues])).toBe(0)
  })

  it('penalises info issues lightly', () => {
    const infoOnly: CheckResult = {
      check: 'auth',
      status: 'drifted',
      issues: [{ id: '1', check: 'auth', severity: 'info', title: '', description: '' }],
      durationMs: 5,
    }
    expect(computeScore([infoOnly])).toBe(99)
  })

  it('penalises errored checks', () => {
    const errored: CheckResult = {
      check: 'schema',
      status: 'error',
      issues: [],
      error: 'connection refused',
      durationMs: 10,
    }
    expect(computeScore([errored])).toBe(97) // 100 - 3
  })

  it('does not return 100 when all checks errored', () => {
    const errored: CheckResult = {
      check: 'schema',
      status: 'error',
      issues: [],
      error: 'connection refused',
      durationMs: 10,
    }
    const errored2: CheckResult = {
      check: 'rls',
      status: 'error',
      issues: [],
      error: 'timeout',
      durationMs: 10,
    }
    const score = computeScore([errored, errored2])
    expect(score).toBe(94) // 100 - 3 - 3
    expect(score).toBeLessThan(100)
  })

  it('combines error and drift penalties', () => {
    const errored: CheckResult = {
      check: 'schema',
      status: 'error',
      issues: [],
      error: 'connection refused',
      durationMs: 10,
    }
    const score = computeScore([drifted, errored])
    // drifted: 1 critical (15) + 1 warning (5) = 20
    // errored: 1 error (3) = 3
    expect(score).toBe(77) // 100 - 20 - 3
  })
})

// ─── issue #40: posture findings are not drift ──────────────────────────────

function issues(check: CheckName, n: number, severity: 'critical' | 'warning' | 'info'): DriftIssue[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${check}-${i}`, check, severity, title: 't', description: 'd',
  }))
}

describe('drift score excludes non-comparative checks (issue #40)', () => {
  it('two identical environments score 100 despite pre-existing RLS gaps', () => {
    // The reported case: every comparison layer clean, yet 0/100 because RLS
    // Coverage reports the same tables whichever pair you diff.
    const results: CheckResult[] = [
      { check: 'schema', status: 'clean', issues: [], durationMs: 1 },
      { check: 'rls', status: 'clean', issues: [], durationMs: 1 },
      { check: 'rls-coverage', status: 'drifted', issues: issues('rls-coverage', 8, 'critical'), durationMs: 1 },
      { check: 'migrations', status: 'drifted', issues: issues('migrations', 1, 'info'), durationMs: 1 },
    ]
    expect(computeScore(results)).toBe(100)
  })

  it('still penalises genuine drift', () => {
    const results: CheckResult[] = [
      { check: 'rls', status: 'drifted', issues: issues('rls', 1, 'critical'), durationMs: 1 },
    ]
    expect(computeScore(results)).toBe(100 - SCORE_PENALTY_CRITICAL)
  })

  it('a posture finding does not dilute a real drift penalty', () => {
    const withPosture: CheckResult[] = [
      { check: 'rls', status: 'drifted', issues: issues('rls', 1, 'critical'), durationMs: 1 },
      { check: 'rls-coverage', status: 'drifted', issues: issues('rls-coverage', 8, 'critical'), durationMs: 1 },
    ]
    const without: CheckResult[] = [withPosture[0]]
    expect(computeScore(withPosture)).toBe(computeScore(without))
  })

  it('an errored comparison check still costs score', () => {
    const results: CheckResult[] = [
      { check: 'rls', status: 'error', issues: [], error: 'boom', durationMs: 1 },
    ]
    expect(computeScore(results)).toBe(100 - SCORE_PENALTY_ERROR)
  })
})

describe('computePostureScore', () => {
  it('scores the posture checks so the findings are not discarded', () => {
    const results: CheckResult[] = [
      { check: 'schema', status: 'clean', issues: [], durationMs: 1 },
      { check: 'rls-coverage', status: 'drifted', issues: issues('rls-coverage', 8, 'critical'), durationMs: 1 },
    ]
    // 8 criticals is well past the floor — the point is that it is not 100.
    expect(computePostureScore(results)).toBe(0)
  })

  it('is 100 when the posture checks ran and found nothing', () => {
    const results: CheckResult[] = [
      { check: 'rls-coverage', status: 'clean', issues: [], durationMs: 1 },
      { check: 'migrations', status: 'clean', issues: [], durationMs: 1 },
    ]
    expect(computePostureScore(results)).toBe(100)
  })

  it('is null when no posture check ran, so no line is printed for it', () => {
    const results: CheckResult[] = [
      { check: 'schema', status: 'clean', issues: [], durationMs: 1 },
    ]
    expect(computePostureScore(results)).toBeNull()
  })

  it('ignores drift from the comparison checks', () => {
    const results: CheckResult[] = [
      { check: 'rls', status: 'drifted', issues: issues('rls', 4, 'critical'), durationMs: 1 },
      { check: 'migrations', status: 'clean', issues: [], durationMs: 1 },
    ]
    expect(computePostureScore(results)).toBe(100)
  })
})

describe('isComparisonCheck', () => {
  it('classifies the two target-only checks as posture', () => {
    expect(isComparisonCheck('rls-coverage')).toBe(false)
    expect(isComparisonCheck('migrations')).toBe(false)
  })

  it('classifies every other check as a comparison', () => {
    const posture = CHECK_NAMES.filter(n => !isComparisonCheck(n))
    expect(posture).toEqual(['rls-coverage', 'migrations'])
  })
})
