import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { Check, type CheckContext } from './base'

interface TableInfo {
  schemaname: string
  tablename: string
}

/** Query tables where RLS is disabled; no schema filter applied. */
const TABLES_WITHOUT_RLS_SQL = `
  SELECT n.nspname AS schemaname, c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relrowsecurity = false
  ORDER BY n.nspname, c.relname
`

/**
 * Checks that every user table in the target database has Row Level Security
 * enabled (`relrowsecurity = true`).
 *
 * Unlike the existing `rls` check (which detects policy drift between two
 * environments), this check detects absolute coverage gaps — tables that never
 * had RLS turned on at all. This is the precise vulnerability pattern described
 * in CVE-2025-48757.
 */
export class RlsCoverageCheck extends Check {
  readonly name = 'rls-coverage' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const ignoreSchemas = ctx.config.ignoreSchemas ?? []
    const tables = await this.fetchTablesWithoutRls(ctx.target.dbUrl, ignoreSchemas)
    return tables.map(buildIssue)
  }

  private async fetchTablesWithoutRls(dbUrl: string, ignoreSchemas: string[]): Promise<TableInfo[]> {
    if (ignoreSchemas.length === 0) {
      return this.queryFn(dbUrl, TABLES_WITHOUT_RLS_SQL) as unknown as TableInfo[]
    }
    const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
    const sql = `
      SELECT n.nspname AS schemaname, c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND c.relrowsecurity = false
        AND n.nspname NOT IN (${placeholders})
      ORDER BY n.nspname, c.relname
    `
    return this.queryFn(dbUrl, sql, ignoreSchemas) as unknown as TableInfo[]
  }
}

function buildIssue(t: TableInfo): DriftIssue {
  const tableRef = `"${t.schemaname}"."${t.tablename}"`
  return {
    id: `rls-coverage-${t.schemaname}.${t.tablename}`,
    check: 'rls-coverage',
    severity: 'critical',
    title: `RLS not enabled: ${t.schemaname}.${t.tablename}`,
    description: `Table ${tableRef} has Row Level Security disabled. Any authenticated user can access all rows without policy restrictions — this is the CVE-2025-48757 vulnerability pattern.`,
    targetValue: t,
    sql: {
      up: `ALTER TABLE ${tableRef} ENABLE ROW LEVEL SECURITY;`,
      down: `ALTER TABLE ${tableRef} DISABLE ROW LEVEL SECURITY;`,
    },
  }
}
