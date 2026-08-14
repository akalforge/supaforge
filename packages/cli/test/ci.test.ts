import { describe, it, expect } from 'vitest'
import { formatAnnotation, formatGitHubAnnotations, computeCiExitCode, formatCiSummary, type FailOn } from '../src/ci.js'
import type { ScanResult, DriftIssue } from '../src/types/drift.js'

function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: '2024-01-01T00:00:00.000Z',
    source: 'staging',
    target: 'production',
    checks: [],
    score: 100,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    ...overrides,
  }
}

function makeIssue(overrides: Partial<DriftIssue> = {}): DriftIssue {
  return {
    id: 'rls-missing-public.users.users_read',
    check: 'rls',
    severity: 'critical',
    title: 'Missing RLS policy: users_read',
    description: 'Policy is missing from production. CVE-2025-48757 risk.',
    ...overrides,
  }
}

describe('formatAnnotation', () => {
  it('formats critical issues as ::error annotations', () => {
    const issue = makeIssue({ severity: 'critical', title: 'Missing RLS', description: 'Policy missing' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::error title=/)
    expect(line).toContain('Missing RLS')
    expect(line).toContain('Policy missing')
  })

  it('formats warning issues as ::warning annotations', () => {
    const issue = makeIssue({ severity: 'warning', title: 'Extra policy', description: 'Extra policy in target' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::warning title=/)
  })

  it('formats info issues as ::warning annotations', () => {
    const issue = makeIssue({ severity: 'info', title: 'Info issue', description: 'Some info' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::warning title=/)
  })

  it('escapes newlines in description', () => {
    const issue = makeIssue({ description: 'Line one\nLine two' })
    const line = formatAnnotation(issue)
    expect(line).toContain('%0A')
    expect(line).not.toContain('\n')
  })

  it('escapes carriage returns in description', () => {
    const issue = makeIssue({ description: 'Line one\r\nLine two' })
    const line = formatAnnotation(issue)
    expect(line).toContain('%0D')
    expect(line).toContain('%0A')
  })

  it('percent-encodes commas and colons in title to avoid breaking annotation syntax', () => {
    const issue = makeIssue({ title: 'Missing: table, index' })
    const line = formatAnnotation(issue)
    expect(line).toContain('Missing%3A table%2C index')
    expect(line).not.toContain('\\')
  })

  it('escapes percent signs first so encoded sequences are not double-encoded', () => {
    const issue = makeIssue({ title: '100%,done', description: 'was 50% before' })
    const line = formatAnnotation(issue)
    expect(line).toBe('::error title=100%25%2Cdone::was 50%25 before')
  })

  it('produces well-formed annotation line', () => {
    const issue = makeIssue({ severity: 'critical', title: 'Critical', description: 'desc' })
    const line = formatAnnotation(issue)
    expect(line).toBe('::error title=Critical::desc')
  })
})

describe('formatGitHubAnnotations', () => {
  it('returns empty array for clean scan', () => {
    expect(formatGitHubAnnotations(makeResult())).toHaveLength(0)
  })

  it('returns one annotation per issue across all checks', () => {
    const result = makeResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            makeIssue(),
            makeIssue({ id: 'rls-2', severity: 'warning', title: 'Extra policy', description: 'extra' }),
          ],
          durationMs: 10,
        },
        {
          check: 'schema',
          status: 'drifted',
          issues: [makeIssue({ id: 'schema-1', check: 'schema', title: 'Schema drift', description: 'Missing table' })],
          durationMs: 5,
        },
      ],
    })
    const annotations = formatGitHubAnnotations(result)
    expect(annotations).toHaveLength(3)
    expect(annotations[0]).toMatch(/^::error/)
    expect(annotations[1]).toMatch(/^::warning/)
    expect(annotations[2]).toMatch(/^::error/)
  })

  it('skips checks with no issues', () => {
    const result = makeResult({
      checks: [
        { check: 'schema', status: 'clean', issues: [], durationMs: 5 },
        { check: 'rls', status: 'drifted', issues: [makeIssue()], durationMs: 10 },
      ],
    })
    expect(formatGitHubAnnotations(result)).toHaveLength(1)
  })
})

describe('computeCiExitCode', () => {
  it('returns 0 for clean scan', () => {
    expect(computeCiExitCode(makeResult(), 'critical')).toBe(0)
  })

  it('returns 2 when any check has error status', () => {
    const result = makeResult({
      checks: [{ check: 'schema', status: 'error', issues: [], error: 'DB unreachable', durationMs: 0 }],
    })
    expect(computeCiExitCode(result, 'critical')).toBe(2)
  })

  it('error status takes precedence over drift threshold', () => {
    const result = makeResult({
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
      checks: [
        { check: 'rls', status: 'error', issues: [], error: 'Connection failed', durationMs: 0 },
      ],
    })
    expect(computeCiExitCode(result, 'critical')).toBe(2)
  })

  describe('fail-on=critical', () => {
    it('returns 1 only when critical issues exist', () => {
      const withCritical = makeResult({ summary: { total: 1, critical: 1, warning: 0, info: 0 } })
      const withWarning  = makeResult({ summary: { total: 1, critical: 0, warning: 1, info: 0 } })
      const withInfo     = makeResult({ summary: { total: 1, critical: 0, warning: 0, info: 1 } })
      expect(computeCiExitCode(withCritical, 'critical')).toBe(1)
      expect(computeCiExitCode(withWarning,  'critical')).toBe(0)
      expect(computeCiExitCode(withInfo,     'critical')).toBe(0)
    })
  })

  describe('fail-on=warning', () => {
    it('returns 1 on critical or warning, 0 on info only', () => {
      const withCritical = makeResult({ summary: { total: 1, critical: 1, warning: 0, info: 0 } })
      const withWarning  = makeResult({ summary: { total: 1, critical: 0, warning: 1, info: 0 } })
      const withInfo     = makeResult({ summary: { total: 1, critical: 0, warning: 0, info: 1 } })
      expect(computeCiExitCode(withCritical, 'warning')).toBe(1)
      expect(computeCiExitCode(withWarning,  'warning')).toBe(1)
      expect(computeCiExitCode(withInfo,     'warning')).toBe(0)
    })
  })

  describe('fail-on=any', () => {
    it('returns 1 for any issue including info', () => {
      const withInfo = makeResult({ summary: { total: 1, critical: 0, warning: 0, info: 1 } })
      expect(computeCiExitCode(withInfo, 'any')).toBe(1)
    })

    it('returns 0 for zero issues', () => {
      expect(computeCiExitCode(makeResult(), 'any')).toBe(0)
    })
  })

  it('uses critical as default when no failOn provided', () => {
    const withWarning = makeResult({ summary: { total: 1, critical: 0, warning: 1, info: 0 } })
    expect(computeCiExitCode(withWarning)).toBe(0)
  })
})

describe('formatCiSummary', () => {
  it('groups critical and warning issues separately', () => {
    const result = makeResult({
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            makeIssue({ id: 'rls-1', severity: 'critical', title: 'Critical issue' }),
            makeIssue({ id: 'rls-2', severity: 'warning',  title: 'Warning issue'  }),
          ],
          durationMs: 10,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues).toHaveLength(1)
    expect(summary.criticalIssues[0].title).toBe('Critical issue')
    expect(summary.warningIssues).toHaveLength(1)
    expect(summary.warningIssues[0].title).toBe('Warning issue')
  })

  it('includes score and timestamp', () => {
    const result = makeResult({ score: 75, timestamp: '2024-06-01T12:00:00Z' })
    const summary = formatCiSummary(result)
    expect(summary.score).toBe(75)
    expect(summary.timestamp).toBe('2024-06-01T12:00:00Z')
  })

  it('omits info issues from both lists', () => {
    const result = makeResult({
      summary: { total: 1, critical: 0, warning: 0, info: 1 },
      checks: [
        {
          check: 'roles',
          status: 'drifted',
          issues: [makeIssue({ id: 'info-1', severity: 'info', check: 'roles', title: 'Info issue' })],
          durationMs: 5,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues).toHaveLength(0)
    expect(summary.warningIssues).toHaveLength(0)
  })

  it('includes check name in each issue entry', () => {
    const result = makeResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [makeIssue({ id: 'rls-1', check: 'rls' })],
          durationMs: 5,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues[0].check).toBe('rls')
  })
})

// ── Regression: issue #29 ─────────────────────────────────────────────────
// --ci exits 2 on an errored check, but the JSON artifact carried no error
// field. Anyone reading the uploaded report rather than the exit code saw a
// clean summary and no indication that a check had never run.

describe('formatCiSummary error signal (issue #29)', () => {
  const withError: ScanResult = {
    timestamp: '2026-03-21T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [
      { check: 'schema', status: 'error', issues: [], durationMs: 5000, error: 'Schema diff timed out after 5s' },
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
    ],
    score: 97,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('reports the errored check and its message', () => {
    const out = formatCiSummary(withError)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].check).toBe('schema')
    expect(out.errors[0].message).toContain('timed out')
  })

  it('emits an empty array on a healthy scan, so the field is always present', () => {
    const clean: ScanResult = { ...withError, checks: [withError.checks[1]], score: 100 }
    expect(formatCiSummary(clean).errors).toEqual([])
  })

  it('substitutes a message when a check errored without one', () => {
    const noMessage: ScanResult = {
      ...withError,
      checks: [{ check: 'schema', status: 'error', issues: [], durationMs: 1 }],
    }
    const out = formatCiSummary(noMessage)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].message).toBeTruthy()
  })

  it('tolerates a malformed result rather than throwing', () => {
    expect(() => formatCiSummary({ ...withError, checks: undefined as never })).not.toThrow()
  })
})
