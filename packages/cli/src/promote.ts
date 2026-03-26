import pg from 'pg'
import type { ScanResult, SyncAction } from './types/drift'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface PromoteOptions {
  /** Target database connection string */
  dbUrl: string
  /** The scan result with SQL fixes to apply */
  scanResult: ScanResult
  /** Only promote specific layers */
  layers?: string[]
  /** Dry-run mode — print SQL without executing */
  dryRun?: boolean
  /** Fetch function for API-based sync actions (defaults to globalThis.fetch) */
  fetchFn?: FetchFn
}

export interface PromoteResult {
  applied: { layer: string; issueId: string; sql?: string; action?: string }[]
  skipped: { layer: string; issueId: string; reason: string }[]
  errors: { layer: string; issueId: string; error: string }[]
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const { dbUrl, scanResult, layers, dryRun = false, fetchFn = globalThis.fetch.bind(globalThis) } = options

  const result: PromoteResult = { applied: [], skipped: [], errors: [] }

  const sqlStatements: { layer: string; issueId: string; sql: string }[] = []
  const apiActions: { layer: string; issueId: string; action: SyncAction }[] = []

  for (const layerResult of scanResult.layers) {
    if (layerResult.status !== 'drifted') continue
    if (layers && !layers.includes(layerResult.layer)) continue

    for (const issue of layerResult.issues) {
      if (issue.sql?.up) {
        sqlStatements.push({ layer: layerResult.layer, issueId: issue.id, sql: issue.sql.up })
      } else if (issue.action) {
        apiActions.push({ layer: layerResult.layer, issueId: issue.id, action: issue.action })
      } else {
        result.skipped.push({
          layer: layerResult.layer,
          issueId: issue.id,
          reason: 'No SQL fix or API action available',
        })
      }
    }
  }

  if (dryRun) {
    for (const stmt of sqlStatements) {
      result.applied.push({ layer: stmt.layer, issueId: stmt.issueId, sql: stmt.sql })
    }
    for (const act of apiActions) {
      result.applied.push({ layer: act.layer, issueId: act.issueId, action: act.action.label })
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
          result.applied.push({ layer: stmt.layer, issueId: stmt.issueId, sql: stmt.sql })
        } catch (err) {
          result.errors.push({
            layer: stmt.layer,
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

      result.applied.push({ layer: act.layer, issueId: act.issueId, action: act.action.label })
    } catch (err) {
      result.errors.push({
        layer: act.layer,
        issueId: act.issueId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
