import { describe, it, expect } from 'vitest'
import { computeScore, summarize } from '../src/scoring.js'
import type { LayerResult } from '../src/types/drift.js'

const clean: LayerResult = {
  layer: 'schema',
  status: 'clean',
  issues: [],
  durationMs: 10,
}

const drifted: LayerResult = {
  layer: 'rls',
  status: 'drifted',
  issues: [
    { id: '1', layer: 'rls', severity: 'critical', title: 'Missing policy', description: '' },
    { id: '2', layer: 'rls', severity: 'warning', title: 'Extra policy', description: '' },
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

  it('aggregates across multiple layers', () => {
    const infoResult: LayerResult = {
      layer: 'cron',
      status: 'drifted',
      issues: [{ id: '3', layer: 'cron', severity: 'info', title: 'Extra job', description: '' }],
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
    const manyIssues: LayerResult = {
      ...drifted,
      issues: Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        layer: 'rls' as const,
        severity: 'critical' as const,
        title: '',
        description: '',
      })),
    }
    expect(computeScore([manyIssues])).toBe(0)
  })

  it('penalises info issues lightly', () => {
    const infoOnly: LayerResult = {
      layer: 'auth',
      status: 'drifted',
      issues: [{ id: '1', layer: 'auth', severity: 'info', title: '', description: '' }],
      durationMs: 5,
    }
    expect(computeScore([infoOnly])).toBe(99)
  })
})
