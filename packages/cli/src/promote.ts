import pg from 'pg'
import { pgClientConfig } from './db.js'
import type { ScanResult, SyncAction } from './types/drift'
import { errMsg } from './utils/error'
import { isDestructiveSql } from './dbdiff'
import { orderStatements, referencedTables, createdPolicies, createsOnlyPolicies } from './sql-deps.js'
import { applyTableFilter, isFiltered, type TableFilter } from './utils/table-filter.js'
import { isComparisonCheck } from './types/drift.js'
import { matchesGlob } from './utils/strings.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface PromoteOptions {
  /** Target database connection string */
  dbUrl: string
  /** The scan result with SQL fixes to apply */
  scanResult: ScanResult
  /** Only promote specific checks */
  checks?: string[]
  /** Also apply posture fixes; off by default — see planWork */
  applyPosture?: boolean
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

/** Where a fix came from: which check reported it, and under which issue id. */
interface FixOrigin {
  check: string
  issueId: string
}

type PlannedSql = FixOrigin & { sql: string }
type PlannedAction = FixOrigin & { action: SyncAction }
type PlannedSkip = FixOrigin & { reason: string }

export interface PromoteResult {
  applied: (FixOrigin & { sql?: string; action?: string })[]
  skipped: PlannedSkip[]
  errors: (FixOrigin & { error: string })[]
  /**
   * Fixes that ran and were then undone because a later statement in the same
   * transaction failed. Reported separately from `applied`, which only ever
   * lists what is actually in the target now.
   */
  rolledBack?: (FixOrigin & { sql?: string })[]
}

interface PlannedWork {
  sqlStatements: PlannedSql[]
  apiActions: PlannedAction[]
  skipped: PlannedSkip[]
}

/** What `planWork` needs to know beyond the scan result itself. */
export interface PlanOptions {
  checks?: string[]
  /**
   * Also apply fixes from the checks that judge the target on its own rather
   * than comparing it to the source. Off by default — see planWork.
   */
  applyPosture?: boolean
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
    // A posture check judges the target on its own and fires identically
    // whichever pair you diff, so its fix is not a reconciliation — applying it
    // changes the target away from the source and *creates* drift. Enabling RLS
    // on a table the source leaves open is the clear case: the next diff reports
    // "RLS enabled unexpectedly", the next sync switches it back off, and the
    // coverage check flags it again, forever. Worse, RLS enabled without the
    // policies to go with it denies every row to non-owners, so a posture fix
    // applied to a working table can take it offline.
    //
    // Naming the check explicitly (--check=rls-coverage) or passing
    // --apply-posture is taken as asking for it on purpose.
    const askedForExplicitly = options.checks?.includes(checkResult.check) ?? false
    if (!isComparisonCheck(checkResult.check) && !options.applyPosture && !askedForExplicitly) {
      for (const issue of checkResult.issues) {
        plan.skipped.push({
          check: checkResult.check,
          issueId: issue.id,
          reason: 'Posture finding about the target, not drift from the source — '
            + 'applying it would create drift. Use --apply-posture to apply anyway.',
        })
      }
      continue
    }

    for (const issue of checkResult.issues) {
      const at = { check: checkResult.check, issueId: issue.id }
      const outcome = classifyIssue(issue, options)

      if (outcome.kind === 'sql') plan.sqlStatements.push({ ...at, sql: outcome.sql })
      else if (outcome.kind === 'api') plan.apiActions.push({ ...at, action: outcome.action })
      else plan.skipped.push({ ...at, reason: outcome.reason })
    }
  }

  plan.sqlStatements = orderStatements(plan.sqlStatements, s => s.sql)
  plan.sqlStatements = dropDuplicatePolicyFixes(plan.sqlStatements, plan.skipped)
  return plan
}

/**
 * Remove a policy fix that an earlier statement already performs.
 *
 * Since `@dbdiff/cli` 3.0.0-rc.10 the schema check's SQL creates RLS policies
 * itself, which the rls check has always done too. Both land in one fix set, the
 * second fails with "policy ... already exists", and because the apply is
 * transactional that single collision discards every other fix with it — so a
 * new policy could not be synced at all.
 *
 * Run over the statements in execution order, after `orderStatements`, so
 * "already created" means already created by something that genuinely runs
 * first rather than merely reported first.
 *
 * Only a statement that does nothing but create the policy is dropped. The
 * schema check bundles its policy with the table and the ENABLE ROW LEVEL
 * SECURITY beside it, and losing that would be far worse than the collision.
 */
function dropDuplicatePolicyFixes(
  statements: PlannedSql[],
  skipped: PlannedWork['skipped'],
): PlannedSql[] {
  const alreadyCreated = new Set<string>()
  const kept: PlannedSql[] = []

  for (const statement of statements) {
    const policies = createdPolicies(statement.sql)
    const isDuplicate = policies.length > 0
      && policies.every(p => alreadyCreated.has(p))
      && createsOnlyPolicies(statement.sql)

    if (isDuplicate) {
      skipped.push({
        check: statement.check,
        issueId: statement.issueId,
        reason: 'Already created by the schema fix for the same policy',
      })
      continue
    }

    for (const p of policies) alreadyCreated.add(p)
    kept.push(statement)
  }

  return kept
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
  statements: PlannedSql[],
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
  statements: PlannedSql[],
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
  statements: PlannedSql[],
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
  actions: PlannedAction[],
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
