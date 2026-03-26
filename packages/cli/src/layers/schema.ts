import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { Layer, type LayerContext } from './base'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 1: Schema Drift — powered by @dbdiff/cli.
 *
 * Shells out to `npx @dbdiff/cli --supabase` to diff table structure,
 * columns, indexes, constraints, and sequences between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class SchemaLayer extends Layer {
  readonly name = 'schema' as const

  constructor(private runFn: RunDbDiffFn = runDbDiff) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    try {
      const result = await this.runFn({
        sourceUrl: ctx.source.dbUrl,
        targetUrl: ctx.target.dbUrl,
        type: 'schema',
        include: 'both',
        ignoreSchemas: ctx.config.ignoreSchemas,
      })
      return sqlToIssues(result, 'schema')
    } catch (err) {
      if (err instanceof Error && err.message.includes('@dbdiff/cli is not installed')) {
        return []
      }
      throw err
    }
  }
}
