import { describe, it, expect } from 'vitest'
import { renderSummary, renderDetailed } from '../src/render.js'
import type { ScanResult } from '../src/types/drift.js'

const cleanResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
  ],
  score: 100,
  summary: { total: 0, critical: 0, warning: 0, info: 0 },
}

const driftedResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    {
      check: 'rls',
      status: 'drifted',
      issues: [{
        id: '1',
        check: 'rls',
        severity: 'critical',
        title: 'Missing RLS policy: users_read',
        description: 'Policy exists in source but not target',
        sql: { up: 'CREATE POLICY "users_read" ON "public"."users";', down: 'DROP POLICY "users_read";' },
      }],
      durationMs: 20,
    },
    {
      check: 'cron',
      status: 'drifted',
      issues: [{
        id: '2',
        check: 'cron',
        severity: 'warning',
        title: 'Missing cron job: cleanup',
        description: 'Job exists in source but not target',
      }],
      durationMs: 15,
    },
  ],
  score: 80,
  summary: { total: 2, critical: 1, warning: 1, info: 0 },
}

describe('renderSummary', () => {
  it('shows clean message when no drift', () => {
    const output = renderSummary(cleanResult)
    expect(output).toContain('no drift detected')
    expect(output).toContain('100/100')
  })

  it('shows issue count when drift found', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 drift issues')
    expect(output).toContain('CRITICAL')
    expect(output).toContain('80/100')
  })

  it('shows source and target', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('dev')
    expect(output).toContain('prod')
  })

  it('shows check names', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('RLS Policies')
    expect(output).toContain('Cron Jobs')
  })
})

describe('renderDetailed', () => {
  it('includes SQL fixes', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('CREATE POLICY')
    expect(output).toContain('SQL fix')
  })

  it('shows issue details', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('Missing RLS policy')
    expect(output).toContain('CRITICAL')
  })

  it('shows check headers for drifted checks', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('Layer 2: RLS Policies')
    expect(output).toContain('Layer 6: Cron Jobs')
  })
})
