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

describe('error rendering', () => {
  const errorResult: ScanResult = {
    timestamp: '2026-04-13T00:00:00.000Z',
    source: 'local',
    target: 'prod',
    checks: [
      {
        check: 'schema',
        status: 'error',
        issues: [],
        error: 'Command failed: postgres://user:***@host/db',
        durationMs: 50,
      },
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
    ],
    score: 90,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('shows error marker and message for errored checks', () => {
    const output = renderSummary(errorResult)
    expect(output).toContain('✖')
    expect(output).toContain('error:')
    expect(output).toContain('Command failed')
  })

  it('shows clean marker for non-errored checks', () => {
    const output = renderSummary(errorResult)
    expect(output).toContain('✓')
  })

  it('does not show raw credentials in error output', () => {
    const output = renderSummary(errorResult)
    expect(output).not.toContain('password')
    expect(output).toContain('***')
  })

  it('shows fallback label when error status has no error message', () => {
    const noMsgResult: ScanResult = {
      ...errorResult,
      checks: [
        { check: 'rls', status: 'error', issues: [], durationMs: 10 },
      ],
    }
    const output = renderSummary(noMsgResult)
    expect(output).toContain('✖')
    expect(output).toContain('error: check failed')
  })
})

describe('score color thresholds', () => {
  function makeResult(score: number): ScanResult {
    return {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [],
      score,
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
    }
  }

  it('shows score at 100', () => {
    const output = renderSummary(makeResult(100))
    expect(output).toContain('100/100')
  })

  it('shows score at 80 (green boundary)', () => {
    const output = renderSummary(makeResult(80))
    expect(output).toContain('80/100')
  })

  it('shows score at 79 (yellow boundary)', () => {
    const output = renderSummary(makeResult(79))
    expect(output).toContain('79/100')
  })

  it('shows score at 50 (yellow lower boundary)', () => {
    const output = renderSummary(makeResult(50))
    expect(output).toContain('50/100')
  })

  it('shows score at 49 (red boundary)', () => {
    const output = renderSummary(makeResult(49))
    expect(output).toContain('49/100')
  })

  it('shows score at 0', () => {
    const output = renderSummary(makeResult(0))
    expect(output).toContain('0/100')
  })
})

describe('singular and plural nouns', () => {
  it('uses singular "issue" for exactly one drift issue', () => {
    const result: ScanResult = {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [{
        check: 'rls',
        status: 'drifted',
        issues: [{ id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' }],
        durationMs: 10,
      }],
      score: 85,
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const output = renderSummary(result)
    expect(output).toContain('1 drift issue')
    expect(output).not.toContain('1 drift issues')
  })

  it('uses plural "issues" for two or more drift issues', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 drift issues')
  })

  it('uses singular "check" when exactly one check has drift', () => {
    const result: ScanResult = {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [{
        check: 'rls',
        status: 'drifted',
        issues: [{ id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' }],
        durationMs: 10,
      }],
      score: 85,
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const output = renderSummary(result)
    expect(output).toContain('1 check')
    expect(output).not.toContain('1 checks')
  })

  it('uses plural "checks" when two or more checks have drift', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 checks')
  })
})

describe('skipped check rendering', () => {
  const skippedResult: ScanResult = {
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
      { check: 'vault', status: 'skipped', issues: [], durationMs: 0 },
    ],
    score: 100,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('renders skipped check with hollow circle marker', () => {
    const output = renderSummary(skippedResult)
    expect(output).toContain('○')
  })

  it('shows 0 issues for skipped check', () => {
    const output = renderSummary(skippedResult)
    expect(output).toContain('0 issues')
  })
})

describe('action display in renderDetailed', () => {
  const actionResult: ScanResult = {
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [{
      check: 'auth',
      status: 'drifted',
      issues: [{
        id: 'auth-jwt_exp',
        check: 'auth',
        severity: 'critical',
        title: 'Auth config mismatch: JWT_EXP',
        description: '"JWT_EXP" differs between source (3600) and target (7200).',
        action: {
          method: 'PATCH',
          url: 'https://api.supabase.com/v1/projects/abc/config/auth',
          headers: { Authorization: 'Bearer token' },
          body: { JWT_EXP: 3600 },
          label: 'Set auth config "JWT_EXP" to 3600 in target',
        },
      }],
      durationMs: 20,
    }],
    score: 85,
    summary: { total: 1, critical: 1, warning: 0, info: 0 },
  }

  it('shows API action label for action-only issues', () => {
    const output = renderDetailed(actionResult)
    expect(output).toContain('API action')
    expect(output).toContain('Set auth config "JWT_EXP" to 3600 in target')
  })

  it('does not show SQL fix header for action-only issues', () => {
    const output = renderDetailed(actionResult)
    expect(output).not.toContain('SQL fix')
  })

  it('shows action label alongside issue title and description', () => {
    const output = renderDetailed(actionResult)
    expect(output).toContain('Auth config mismatch: JWT_EXP')
    expect(output).toContain('JWT_EXP" differs between source')
    expect(output).toContain('Set auth config "JWT_EXP"')
  })
})

