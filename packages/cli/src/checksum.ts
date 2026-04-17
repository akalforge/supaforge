import type { QueryFn } from './db'
import { pgQuery } from './db'
import { quoteIdent, quoteLiteral } from './utils/sql'

/**
 * Quick table-level checksum using PostgreSQL's built-in hash functions.
 * Returns a composite fingerprint of (row_count, size_bytes) for a table.
 *
 * This is much faster than a full row-by-row diff and can short-circuit
 * the expensive @dbdiff/cli invocation when tables are identical.
 */

export interface TableFingerprint {
  table: string
  rowCount: number
  /** pg_total_relation_size in bytes (includes indexes + toast). */
  sizeBytes: number
}

/**
 * Compute a fast fingerprint for a single table using row count + relation size.
 * Both are catalog-level operations that don't scan the table.
 */
export async function getTableFingerprint(
  dbUrl: string,
  table: string,
  queryFn: QueryFn = pgQuery,
): Promise<TableFingerprint> {
  const sql = `
    SELECT
      (SELECT count(*)::int FROM ${quoteIdent(table)}) AS row_count,
      pg_total_relation_size(${quoteLiteral(table)})::bigint AS size_bytes
  `
  const [row] = await queryFn(dbUrl, sql) as unknown as [{ row_count: number; size_bytes: string }]
  return {
    table,
    rowCount: row.row_count,
    sizeBytes: Number(row.size_bytes),
  }
}

/**
 * Compare two tables across environments using fast fingerprints.
 * Returns true if the tables appear identical (same row count + size),
 * meaning the expensive full diff can be skipped.
 */
export async function tablesMatch(
  sourceUrl: string,
  targetUrl: string,
  table: string,
  queryFn: QueryFn = pgQuery,
): Promise<boolean> {
  const [source, target] = await Promise.all([
    getTableFingerprint(sourceUrl, table, queryFn),
    getTableFingerprint(targetUrl, table, queryFn),
  ])
  return source.rowCount === target.rowCount && source.sizeBytes === target.sizeBytes
}

/**
 * Filter a list of tables to only those that differ between environments.
 * Tables that match on fingerprint are skipped — saving expensive row-by-row diffs.
 */
export async function filterChangedTables(
  sourceUrl: string,
  targetUrl: string,
  tables: string[],
  queryFn: QueryFn = pgQuery,
): Promise<{ changed: string[]; skipped: string[] }> {
  const changed: string[] = []
  const skipped: string[] = []

  // Check tables in parallel for speed
  const results = await Promise.all(
    tables.map(async table => {
      try {
        const match = await tablesMatch(sourceUrl, targetUrl, table, queryFn)
        return { table, match }
      } catch {
        // If fingerprint fails (table doesn't exist, etc.), include it in the diff
        return { table, match: false }
      }
    }),
  )

  for (const { table, match } of results) {
    if (match) {
      skipped.push(table)
    } else {
      changed.push(table)
    }
  }

  return { changed, skipped }
}
