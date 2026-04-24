import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { Check, type CheckContext } from './base'
import { DEFAULT_IGNORE_SCHEMAS } from '../defaults'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 1: Schema Drift — powered by @dbdiff/cli.
 *
 * Invokes `@dbdiff/cli diff` to diff table structure,
 * columns, indexes, constraints, and sequences between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class SchemaCheck extends Check {
  readonly name = 'schema' as const

  constructor(
    private runFn: RunDbDiffFn = runDbDiff,
    private queryFn: QueryFn = pgQuery,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    try {
      const ignoreSchemas = ctx.config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS
      const [result, ignoredSchemaTables] = await Promise.all([
        this.runFn({
          sourceUrl: ctx.source.dbUrl,
          targetUrl: ctx.target.dbUrl,
          type: 'schema',
          include: 'both',
          ignoreSchemas,
        }),
        this.fetchIgnoredSchemaTables(ctx.target.dbUrl, ignoreSchemas),
      ])
      return sqlToIssues(result, 'schema', ignoreSchemas, ignoredSchemaTables)
    } catch (err) {
      if (err instanceof Error && err.message.includes('@dbdiff/cli is not installed')) {
        return []
      }
      throw err
    }
  }

  /**
   * Query the target DB for table names inside ignored schemas.
   *
   * These are used to detect unqualified FK REFERENCES like `REFERENCES "users"`
   * where "users" lives in the ignored "auth" schema but dbdiff omitted the
   * schema prefix (due to search_path or its own normalisation).
   *
   * Returns a Set of lowercase table names. Fails silently so that a transient
   * DB error here never blocks the main schema diff.
   */
  async fetchIgnoredSchemaTables(dbUrl: string, ignoreSchemas: string[]): Promise<Set<string>> {
    if (ignoreSchemas.length === 0) return new Set()
    try {
      const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
      const rows = await this.queryFn(
        dbUrl,
        `SELECT tablename FROM pg_tables WHERE schemaname IN (${placeholders})`,
        ignoreSchemas,
      )
      return new Set(rows.map(r => String(r.tablename).toLowerCase()))
    } catch {
      // Non-fatal: return empty set and let the existing filter handle what it can
      return new Set()
    }
  }
}
