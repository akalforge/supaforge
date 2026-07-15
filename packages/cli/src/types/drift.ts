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
  durationMs: number
}

export interface ScanResult {
  timestamp: string
  source: string
  target: string
  checks: CheckResult[]
  score: number
  summary: { total: number; critical: number; warning: number; info: number }
}
