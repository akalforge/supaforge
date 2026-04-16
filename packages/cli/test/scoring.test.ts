import { describe, it, expect } from 'vitest'
import { computeScore, summarize } from '../src/scoring.js'
import type { CheckResult } from '../src/types/drift.js'

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
