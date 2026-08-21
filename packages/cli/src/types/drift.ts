export const CHECK_NAMES = [
  'schema', 'rls', 'rls-coverage', 'edge-functions', 'storage', 'auth', 'cron', 'data',
  'webhooks', 'realtime', 'vault', 'extensions', 'migrations', 'roles',
] as const

export type CheckName = (typeof CHECK_NAMES)[number]

export type Severity = 'critical' | 'warning' | 'info'

export const CHECK_META: Record<CheckName, { number: number; emoji: string; label: string }> = {
  'schema':          { number: 1,  emoji: '🗄️',   label: 'Schema' },
  'rls':             { number: 2,  emoji: '🔒',   label: 'RLS Policies' },
  'rls-coverage':    { number: 3,  emoji: '🛡️',   label: 'RLS Coverage' },
  'edge-functions':  { number: 4,  emoji: '⚡',    label: 'Edge Functions' },
  'storage':         { number: 5,  emoji: '🪣',   label: 'Storage' },
  'auth':            { number: 6,  emoji: '🔑',   label: 'Auth Config' },
  'cron':            { number: 7,  emoji: '⏰',   label: 'Cron Jobs' },
  'data':            { number: 8,  emoji: '🗃️',   label: 'Reference Data' },
  'webhooks':        { number: 9,  emoji: '⚡🔗', label: 'Webhooks' },
  'realtime':        { number: 10, emoji: '📡',   label: 'Realtime Publications' },
  'vault':           { number: 11, emoji: '🔐',  label: 'Vault Secrets' },
  'extensions':      { number: 12, emoji: '🧩',  label: 'Postgres Extensions' },
  'migrations':      { number: 13, emoji: '📋',  label: 'Migration History' },
  'roles':           { number: 14, emoji: '👤',  label: 'Postgres Roles & Grants' },
}

/**
 * Whether a check compares the two environments, or reports on the target's
 * own posture regardless of what it is being compared against.
 *
 * Two of the fourteen are not comparisons:
 *
 * - **rls-coverage** reads only the target, listing tables with RLS disabled.
 *   It reports the same tables whichever pair you diff.
 * - **migrations** compares local migration *files* against the target's
 *   tracking table — a project-level observation, not a source-to-target one.
 *
 * Both are real and useful findings, but neither is drift. Counting them
 * toward the drift score meant diffing an environment against *itself* could
 * never score 100, so "no drift detected" stopped being a trustworthy signal
 * and the score was useless as a synchronisation measure (issue #40).
 */
export type CheckKind = 'comparison' | 'posture'

export const CHECK_KIND: Record<CheckName, CheckKind> = {
  'schema':          'comparison',
  'rls':             'comparison',
  'rls-coverage':    'posture',
  'edge-functions':  'comparison',
  'storage':         'comparison',
  'auth':            'comparison',
  'cron':            'comparison',
  'data':            'comparison',
  'webhooks':        'comparison',
  'realtime':        'comparison',
  'vault':           'comparison',
  'extensions':      'comparison',
  'migrations':      'posture',
  'roles':           'comparison',
}

/** Checks that compare source against target. */
export function isComparisonCheck(name: CheckName): boolean {
  return CHECK_KIND[name] === 'comparison'
}

/** API-based sync action for non-SQL drift fixes. */
export interface SyncAction {
  /** HTTP method */
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Full URL (resolved at scan time, using target projectRef). */
  url: string
  /** Request headers (Authorization injected by promote). */
  headers?: Record<string, string>
  /** JSON body to send. */
  body?: unknown
  /** Human-readable description of what this action does. */
  label: string
}

export interface DriftIssue {
  id: string
  check: CheckName
  severity: Severity
  title: string
  description: string
  sourceValue?: unknown
  targetValue?: unknown
  sql?: { up: string; down: string }
  /** API-based sync action (for non-SQL fixes like storage buckets, auth config, edge functions). */
  action?: SyncAction
}

export interface CheckResult {
  check: CheckName
  status: 'clean' | 'drifted' | 'error' | 'skipped'
  issues: DriftIssue[]
  error?: string
  /**
   * Why the check declined to run — missing credentials, an absent extension,
   * nothing configured to compare.
   *
   * Present only when status is 'skipped'. Without it a skipped layer was
   * indistinguishable from a clean one in both the terminal output and the
   * JSON payload (issue #42).
   */
  skipReason?: string
  durationMs: number
}

export interface ScanResult {
  timestamp: string
  source: string
  target: string
  checks: CheckResult[]
  /**
   * How closely the two environments match, 0–100, over the comparison checks
   * only. Posture findings are excluded so a genuinely synchronised pair can
   * reach 100 even when it carries pre-existing findings on both sides.
   */
  score: number
  /**
   * The target's own security and tracking posture, 0–100, over the posture
   * checks only. `null` when none of them ran.
   */
  postureScore: number | null
  summary: { total: number; critical: number; warning: number; info: number }
}
