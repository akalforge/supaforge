import pg from 'pg'
import type { ScanResult } from './types/drift'

export interface PromoteOptions {
  /** Target database connection string */
  dbUrl: string
  /** The scan result with SQL fixes to apply */
  scanResult: ScanResult
  /** Only promote specific layers */
  layers?: string[]
  /** Dry-run mode — print SQL without executing */
  dryRun?: boolean
}

export interface PromoteResult {
  applied: { layer: string; issueId: string; sql: string }[]
  skipped: { layer: string; issueId: string; reason: string }[]
  errors: { layer: string; issueId: string; error: string }[]
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const { dbUrl, scanResult, layers, dryRun = false } = options

  const result: PromoteResult = { applied: [], skipped: [], errors: [] }

  const statements: { layer: string; issueId: string; sql: string }[] = []

  for (const layerResult of scanResult.layers) {
    if (layerResult.status !== 'drifted') continue
    if (layers && !layers.includes(layerResult.layer)) continue

    for (const issue of layerResult.issues) {
      if (!issue.sql?.up) {
        result.skipped.push({
          layer: layerResult.layer,
          issueId: issue.id,
          reason: 'No SQL fix available',
        })
        continue
      }
      statements.push({ layer: layerResult.layer, issueId: issue.id, sql: issue.sql.up })
    }
  }

  if (dryRun) {
    result.applied = statements
    return result
  }

  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    for (const stmt of statements) {
      try {
        await client.query(stmt.sql)
        result.applied.push(stmt)
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

  return result
}
