import pg from 'pg'
import { pgClientConfig } from './db.js'
import type { ScanResult, SyncAction } from './types/drift'
import { errMsg } from './utils/error'
import { isDestructiveSql } from './dbdiff'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface PromoteOptions {
  /** Target database connection string */
  dbUrl: string
  /** The scan result with SQL fixes to apply */
  scanResult: ScanResult
  /** Only promote specific checks */
  checks?: string[]
  /** Dry-run mode — print SQL without executing */
  dryRun?: boolean
  /**
   * Permit statements that destroy data (DROP TABLE, DROP COLUMN).
   *
   * Off by default: those are reported as drift but skipped at apply time, so
   * `supaforge diff --apply` can never drop a table or column without the user
   * asking for it. Set by the `--allow-destructive` flag.
   */
  allowDestructive?: boolean
  /** Fetch function for API-based sync actions (defaults to globalThis.fetch) */
  fetchFn?: FetchFn
}

export interface PromoteResult {
  applied: { check: string; issueId: string; sql?: string; action?: string }[]
  skipped: { check: string; issueId: string; reason: string }[]
  errors: { check: string; issueId: string; error: string }[]
}

interface PlannedWork {
  sqlStatements: { check: string; issueId: string; sql: string }[]
  apiActions: { check: string; issueId: string; action: SyncAction }[]
  skipped: { check: string; issueId: string; reason: string }[]
}

/**
 * Sort a scan result's issues into what can be run as SQL, what needs an API
 * call, and what has to be skipped.
 *
 * Kept separate from promote() so the decision of *what* to apply is one
 * self-contained, directly testable pass, and promote() is left to the
 * execution.
 */
export function planWork(
  scanResult: ScanResult,
  checks?: string[],
  allowDestructive = false,
): PlannedWork {
  const plan: PlannedWork = { sqlStatements: [], apiActions: [], skipped: [] }

  const relevant = scanResult.checks.filter(
    c => c.status === 'drifted' && (!checks || checks.includes(c.check)),
  )

  for (const checkResult of relevant) {
    for (const issue of checkResult.issues) {
      const at = { check: checkResult.check, issueId: issue.id }

      if (!issue.sql?.up) {
        if (issue.action) {
          plan.apiActions.push({ ...at, action: issue.action })
        } else {
          plan.skipped.push({ ...at, reason: 'No SQL fix or API action available' })
        }
        continue
      }

      if (!allowDestructive && isDestructiveSql(issue.sql.up)) {
        plan.skipped.push({
          ...at,
          reason: 'Destructive (drops data) — re-run with --allow-destructive to apply',
        })
        continue
      }

      plan.sqlStatements.push({ ...at, sql: issue.sql.up })
    }
  }

  return plan
}

/**
 * Run the planned SQL against the target on a single connection.
 *
 * One failing statement is recorded and the rest still run — a drift fix set is
 * a list of independent repairs, not a transaction.
 */
async function executeSql(
  dbUrl: string,
  statements: PlannedWork['sqlStatements'],
  result: PromoteResult,
): Promise<void> {
  if (statements.length === 0) return

  const client = new pg.Client(pgClientConfig(dbUrl))
  await client.connect()
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt.sql)
        result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
      } catch (err) {
        result.errors.push({ check: stmt.check, issueId: stmt.issueId, error: errMsg(err) })
      }
    }
  } finally {
    await client.end()
  }
}

/** Run the planned API-based sync actions, recording per-action failures. */
async function executeApiActions(
  actions: PlannedWork['apiActions'],
  fetchFn: FetchFn,
  result: PromoteResult,
): Promise<void> {
  for (const act of actions) {
    try {
      const init: RequestInit = {
        method: act.action.method,
        headers: { 'Content-Type': 'application/json', ...act.action.headers },
      }
      if (act.action.body !== undefined) {
        init.body = JSON.stringify(act.action.body)
      }

      const res = await fetchFn(act.action.url, init)
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`${act.action.method} ${act.action.url} → ${res.status}: ${text}`)
      }

      result.applied.push({ check: act.check, issueId: act.issueId, action: act.action.label })
    } catch (err) {
      result.errors.push({ check: act.check, issueId: act.issueId, error: errMsg(err) })
    }
  }
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const {
    dbUrl,
    scanResult,
    checks,
    dryRun = false,
    allowDestructive = false,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = options

  const { sqlStatements, apiActions, skipped } = planWork(scanResult, checks, allowDestructive)
  const result: PromoteResult = { applied: [], skipped, errors: [] }

  if (dryRun) {
    for (const stmt of sqlStatements) {
      result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    }
    for (const act of apiActions) {
      result.applied.push({ check: act.check, issueId: act.issueId, action: act.action.label })
    }
    return result
  }

  await executeSql(dbUrl, sqlStatements, result)
  await executeApiActions(apiActions, fetchFn, result)

  return result
}
