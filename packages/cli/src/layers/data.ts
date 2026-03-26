import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { Layer, type LayerContext } from './base'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 7: Reference Data Drift — powered by @dbdiff/cli --type=data.
 *
 * Shells out to `npx @dbdiff/cli --supabase --type=data` to diff
 * configured reference/seed tables between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class DataLayer extends Layer {
  readonly name = 'data' as const

  constructor(private runFn: RunDbDiffFn = runDbDiff) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const tables = ctx.config.layers?.data?.tables
    if (!tables?.length) return []

    try {
      const result = await this.runFn({
        sourceUrl: ctx.source.dbUrl,
        targetUrl: ctx.target.dbUrl,
        type: 'data',
        include: 'both',
        ignoreSchemas: ctx.config.ignoreSchemas,
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
