import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { filterChangedTables } from '../checksum'
import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import { Check, CheckSkipped, type CheckContext } from './base'

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
    // Nothing configured to compare is a skip, not a clean comparison — this
    // layer reported a green pass having read nothing at all (issue #42).
    if (!tables?.length) throw new CheckSkipped('no tables configured in checks.data.tables')

    // Fast fingerprint check — skip tables that haven't changed
    const { changed } = await filterChangedTables(
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
        timeoutSeconds: ctx.target?.checks?.schema?.timeout,
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
