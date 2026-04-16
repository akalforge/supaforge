/**
 * Shared SQL escaping utilities for generating safe SQL strings.
 *
 * Used across checks, snapshots, and migration layers to avoid
 * duplicating quoting logic.
 */

/**
 * Quote a schema-qualified or bare identifier for safe inclusion in SQL.
 * Handles `schema.table` → `"schema"."table"` and bare `table` → `"table"`.
 */
export function quoteIdent(name: string): string {
  return name.split('.').map(p => `"${p.replace(/"/g, '""')}"`).join('.')
}

/**
 * Quote a bare identifier (single name, no dot-splitting).
 * Use for column/table names that should never be schema-qualified.
 */
export function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Quote a string value for safe inclusion as a SQL literal.
 * Escapes single quotes by doubling them.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Convert a JavaScript value to a SQL literal representation.
 * Handles null, boolean, number, array, and string types.
 */
export function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL'
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  if (typeof val === 'number') return String(val)
  if (Array.isArray(val)) return `ARRAY[${val.map(v => quoteLiteral(String(v))).join(', ')}]`
  return quoteLiteral(String(val))
}
