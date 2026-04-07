import pg from 'pg'
import type { ScanResult, SyncAction } from './types/drift'

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
  /** Fetch function for API-based sync actions (defaults to globalThis.fetch) */
  fetchFn?: FetchFn
}

export interface PromoteResult {
  applied: { check: string; issueId: string; sql?: string; action?: string }[]
  skipped: { check: string; issueId: string; reason: string }[]
  errors: { check: string; issueId: string; error: string }[]
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const { dbUrl, scanResult, checks, dryRun = false, fetchFn = globalThis.fetch.bind(globalThis) } = options

  const result: PromoteResult = { applied: [], skipped: [], errors: [] }

  const sqlStatements: { check: string; issueId: string; sql: string }[] = []
  const apiActions: { check: string; issueId: string; action: SyncAction }[] = []

  for (const checkResult of scanResult.checks) {
    if (checkResult.status !== 'drifted') continue
    if (checks && !checks.includes(checkResult.check)) continue

    for (const issue of checkResult.issues) {
      if (issue.sql?.up) {
        sqlStatements.push({ check: checkResult.check, issueId: issue.id, sql: issue.sql.up })
      } else if (issue.action) {
        apiActions.push({ check: checkResult.check, issueId: issue.id, action: issue.action })
      } else {
        result.skipped.push({
          check: checkResult.check,
          issueId: issue.id,
          reason: 'No SQL fix or API action available',
        })
      }
    }
  }

  if (dryRun) {
    for (const stmt of sqlStatements) {
      result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    }
    for (const act of apiActions) {
      result.applied.push({ check: act.check, issueId: act.issueId, action: act.action.label })
    }
    return result
  }

  // Execute SQL statements
  if (sqlStatements.length > 0) {
    const client = new pg.Client({ connectionString: dbUrl })
    await client.connect()
    try {
      for (const stmt of sqlStatements) {
        try {
          await client.query(stmt.sql)
          result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
        } catch (err) {
          result.errors.push({
            check: stmt.check,
            issueId: stmt.issueId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } finally {
      await client.end()
    }
  }

  // Execute API-based sync actions
  for (const act of apiActions) {
    try {
      const init: RequestInit = {
        method: act.action.method,
        headers: {
          'Content-Type': 'application/json',
          ...act.action.headers,
        },
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
      result.errors.push({
        check: act.check,
        issueId: act.issueId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
