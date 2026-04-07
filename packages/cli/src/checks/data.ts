import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { Check, type CheckContext } from './base'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 7: Reference Data Drift — powered by @dbdiff/cli --type=data.
 *
 * Invokes `@dbdiff/cli diff --type=data` to diff
 * configured reference/seed tables between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class DataCheck extends Check {
  readonly name = 'data' as const

  constructor(private runFn: RunDbDiffFn = runDbDiff) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const tables = ctx.config.checks?.data?.tables
    if (!tables?.length) return []

    try {
      const result = await this.runFn({
        sourceUrl: ctx.source.dbUrl,
        targetUrl: ctx.target.dbUrl,
        type: 'data',
        include: 'both',
        tables,
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
