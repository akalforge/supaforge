import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { filterChangedTables } from '../checksum'
import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import { Check, type CheckContext } from './base'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 7: Reference Data Drift — powered by @dbdiff/cli --type=data.
 *
 * Uses fast table fingerprinting (row count + relation size) to skip
 * unchanged tables, then invokes `@dbdiff/cli diff --type=data` only
 * for tables that actually differ between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class DataCheck extends Check {
  readonly name = 'data' as const

  constructor(
    private runFn: RunDbDiffFn = runDbDiff,
    private queryFn: QueryFn = pgQuery,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const tables = ctx.config.checks?.data?.tables
    if (!tables?.length) return []

    // Fast fingerprint check — skip tables that haven't changed
    const { changed, skipped } = await filterChangedTables(
      ctx.source.dbUrl,
      ctx.target.dbUrl,
      tables,
      this.queryFn,
    )

    if (changed.length === 0) return []

    try {
      const result = await this.runFn({
        sourceUrl: ctx.source.dbUrl,
        targetUrl: ctx.target.dbUrl,
        type: 'data',
        include: 'both',
        tables: changed,
      })
      return sqlToIssues(result, 'data')
    } catch (err) {
      if (err instanceof Error && err.message.includes('@dbdiff/cli is not installed')) {
        return []
      }
      throw err
    }
  }
}
