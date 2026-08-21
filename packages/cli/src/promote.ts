import pg from 'pg'
import { pgClientConfig } from './db.js'
import type { ScanResult, SyncAction } from './types/drift'
import { errMsg } from './utils/error'
import { isDestructiveSql } from './dbdiff'
import { orderStatements, referencedTables } from './sql-deps.js'
import { applyTableFilter, isFiltered, type TableFilter } from './utils/table-filter.js'
import { matchesGlob } from './utils/strings.js'

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
  /**
   * The table scope the diff ran under.
   *
   * Needed at apply time as well as scan time. `--tables` reaches dbdiff, which
   * scopes *tables* only, so a narrowed fix set still arrives carrying the
   * views, triggers and indexes that hang off the tables it excluded. Applying
   * those fails, because the column or table they need was deliberately not
   * added (issue #48).
   */
  tableFilter?: TableFilter
  /**
   * Apply only these issues, by id. Globs allowed. Undefined means all.
   *
   * Every issue in `--json` already carries a stable id, so a review step can
   * pick a subset out of one diff and apply exactly that, with no new matching
   * syntax to learn.
   */
  only?: string[]
  /**
   * Run every SQL fix in one transaction, rolling the whole set back if any
   * statement fails. On by default — see `executeSql`.
   */
  transactional?: boolean
  /** Fetch function for API-based sync actions (defaults to globalThis.fetch) */
  fetchFn?: FetchFn
}

export interface PromoteResult {
  applied: { check: string; issueId: string; sql?: string; action?: string }[]
  skipped: { check: string; issueId: string; reason: string }[]
  errors: { check: string; issueId: string; error: string }[]
  /**
   * Fixes that ran and were then undone because a later statement in the same
   * transaction failed. Reported separately from `applied`, which only ever
   * lists what is actually in the target now.
   */
  rolledBack?: { check: string; issueId: string; sql?: string }[]
}

interface PlannedWork {
  sqlStatements: { check: string; issueId: string; sql: string }[]
  apiActions: { check: string; issueId: string; action: SyncAction }[]
  skipped: { check: string; issueId: string; reason: string }[]
}

/** What `planWork` needs to know beyond the scan result itself. */
export interface PlanOptions {
  checks?: string[]
  allowDestructive?: boolean
  tableFilter?: TableFilter
  only?: string[]
}

/**
 * Why a fix cannot be applied under the current scope, or null when it can.
 *
 * A fix set narrowed by `--tables` is internally inconsistent by construction:
 * dbdiff's `--tables` covers tables, so the views, triggers and indexes
 * belonging to an excluded table survive the filter while the table change they
 * need does not. Naming the excluded table is the difference between a fix a
 * user can reason about and an error they cannot (issue #48).
 */
export function outOfScopeReason(sql: string, filter: TableFilter | undefined): string | null {
  if (!isFiltered(filter)) return null

  const referenced = referencedTables(sql)
  if (referenced.length === 0) return null

  const excluded = referenced.filter(t => applyTableFilter([t], filter).length === 0)
  if (excluded.length === 0) return null

  const names = excluded.map(t => `'${t}'`).join(', ')
  const flag = filter?.tables?.length ? '--tables' : '--exclude-tables'
  const noun = excluded.length === 1 ? 'table' : 'tables'
  return `Depends on ${noun} ${names}, excluded by ${flag}`
}

/** Does this issue id match any of the `--only` selectors? */
function isSelected(issueId: string, only: string[] | undefined): boolean {
  if (!only?.length) return true
  return only.some(pattern => matchesGlob(issueId, pattern))
}

/**
 * Decide what happens to one issue: run its SQL, call its API, or skip it.
 *
 * Split out of planWork so each reason a fix is withheld is one readable
 * branch, and so the decision can be asserted directly in tests.
 */
function classifyIssue(
  issue: { id: string; sql?: { up: string }; action?: SyncAction },
  options: PlanOptions,
): { kind: 'sql'; sql: string } | { kind: 'api'; action: SyncAction } | { kind: 'skip'; reason: string } {
  if (!isSelected(issue.id, options.only)) {
    return { kind: 'skip', reason: 'Not selected by --only' }
  }

  if (!issue.sql?.up) {
    if (issue.action) return { kind: 'api', action: issue.action }
    return { kind: 'skip', reason: 'No SQL fix or API action available' }
  }

  if (!options.allowDestructive && isDestructiveSql(issue.sql.up)) {
    return { kind: 'skip', reason: 'Destructive (drops data) — re-run with --allow-destructive to apply' }
  }

  const outOfScope = outOfScopeReason(issue.sql.up, options.tableFilter)
  if (outOfScope) return { kind: 'skip', reason: outOfScope }

  return { kind: 'sql', sql: issue.sql.up }
}

/**
 * Sort a scan result's issues into what can be run as SQL, what needs an API
 * call, and what has to be skipped.
 *
 * Kept separate from promote() so the decision of *what* to apply is one
 * self-contained, directly testable pass, and promote() is left to the
 * execution.
 *
 * The SQL comes back in dependency order rather than the order the checks
 * reported it — see `orderStatements`.
 */
export function planWork(scanResult: ScanResult, options: PlanOptions = {}): PlannedWork {
  const plan: PlannedWork = { sqlStatements: [], apiActions: [], skipped: [] }

  const relevant = scanResult.checks.filter(
    c => c.status === 'drifted' && (!options.checks || options.checks.includes(c.check)),
  )

  for (const checkResult of relevant) {
    for (const issue of checkResult.issues) {
      const at = { check: checkResult.check, issueId: issue.id }
      const outcome = classifyIssue(issue, options)

      if (outcome.kind === 'sql') plan.sqlStatements.push({ ...at, sql: outcome.sql })
      else if (outcome.kind === 'api') plan.apiActions.push({ ...at, action: outcome.action })
      else plan.skipped.push({ ...at, reason: outcome.reason })
    }
  }

  plan.sqlStatements = orderStatements(plan.sqlStatements, s => s.sql)
  return plan
}

/**
 * Run the planned SQL against the target on a single connection.
 *
 * Transactional by default. PostgreSQL supports transactional DDL, so a fix set
 * either lands whole or not at all, and a failure leaves the target exactly as
 * it was. The alternative — the behaviour before issue #48 — left a shared
 * environment matching neither the source nor its own previous state, and the
 * person running it having to work out which fixes had landed before retrying.
 *
 * `transactional: false` restores the statement-at-a-time behaviour, for the
 * cases where partial progress is genuinely wanted.
 */
async function executeSql(
  dbUrl: string,
  statements: PlannedWork['sqlStatements'],
  result: PromoteResult,
  transactional: boolean,
): Promise<void> {
  if (statements.length === 0) return

  const client = new pg.Client(pgClientConfig(dbUrl))
  await client.connect()
  try {
    if (transactional) await runInTransaction(client, statements, result)
    else await runIndependently(client, statements, result)
  } finally {
    await client.end()
  }
}

/** One statement at a time: a failure is recorded and the rest still run. */
async function runIndependently(
  client: pg.Client,
  statements: PlannedWork['sqlStatements'],
  result: PromoteResult,
): Promise<void> {
  for (const stmt of statements) {
    try {
      await client.query(stmt.sql)
      result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    } catch (err) {
      result.errors.push({ check: stmt.check, issueId: stmt.issueId, error: errMsg(err) })
    }
  }
}

/**
 * All statements in one transaction: the first failure rolls back everything.
 *
 * What ran before the failure moves to `rolledBack` rather than `applied`,
 * because none of it is in the target any more.
 */
async function runInTransaction(
  client: pg.Client,
  statements: PlannedWork['sqlStatements'],
  result: PromoteResult,
): Promise<void> {
  const done: PromoteResult['applied'] = []
  await client.query('BEGIN')

  for (const stmt of statements) {
    try {
      await client.query(stmt.sql)
      done.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      result.errors.push({ check: stmt.check, issueId: stmt.issueId, error: errMsg(err) })
      result.rolledBack = done
      return
    }
  }

  await client.query('COMMIT')
  result.applied.push(...done)
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
    tableFilter,
    only,
    transactional = true,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = options

  const { sqlStatements, apiActions, skipped } = planWork(scanResult, {
    checks,
    allowDestructive,
    tableFilter,
    only,
  })
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

  await executeSql(dbUrl, sqlStatements, result, transactional)

  // A rolled-back batch leaves the target untouched, so the API calls that
  // would have gone with it must not fire either — they are not transactional
  // and could not be undone.
  if (result.rolledBack) {
    for (const act of apiActions) {
      result.skipped.push({
        check: act.check,
        issueId: act.issueId,
        reason: 'Not attempted — the SQL fixes were rolled back',
      })
    }
    return result
  }

  await executeApiActions(apiActions, fetchFn, result)

  return result
}
