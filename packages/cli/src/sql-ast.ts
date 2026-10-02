/**
 * SQL read by PostgreSQL's own parser, rather than by regular expressions.
 *
 * SupaForge has to understand statements it did not write — DBDiff's fixes, a
 * snapshot's files, migrations — to order them, hold back the destructive
 * ones, and find what they name. Reading that from the text with patterns
 * meant guessing: a role named inside a function body, `TRUNCATE` as a
 * privilege rather than a statement, a quoted name with a dot in it. Each
 * guess that went wrong was a bug, fixed by blanking out more of the text
 * first (sqlSkeleton) and adding another pattern.
 *
 * libpg_query is the parser PostgreSQL itself uses, compiled to WebAssembly.
 * It returns each statement as a tree, so a function body is a string in a
 * field rather than text that might look like DDL, and a name is a list of
 * identifiers rather than something to split on dots.
 *
 * The module is loaded once, when this file is first imported, so every
 * function here is synchronous.
 */
import { loadModule, parseSync } from 'libpg-query'

await loadModule()

/** One parsed statement: its node type, and the node itself. */
export interface Statement {
  /** `DropStmt`, `AlterTableStmt`, `CreatePolicyStmt`… */
  kind: string
  // The parser's tree is untyped JSON; accessors below give it shape.
  node: Record<string, any>
}

/**
 * The statements in `sql`, or undefined when PostgreSQL would not accept it.
 *
 * Undefined rather than an exception: a caller can then fall back to what it
 * did before, which matters while SupaForge is moved over piece by piece.
 */
export function parseStatements(sql: string): Statement[] | undefined {
  try {
    const tree = parseSync(sql) as { stmts?: Array<{ stmt: Record<string, any> }> }
    return (tree.stmts ?? []).map(({ stmt }) => {
      const kind = Object.keys(stmt)[0]
      return { kind, node: stmt[kind] }
    })
  } catch {
    return undefined
  }
}

/** The plain name list of a `List` of `String` nodes, as the parser gives one. */
export function names(list: Array<Record<string, any>> | undefined): string[] {
  return (list ?? []).map(item => item.String?.sval ?? '').filter(Boolean)
}

/** The bare name of a `RangeVar` (a table reference), without its schema. */
export function relationName(rangeVar: Record<string, any> | undefined): string {
  return rangeVar?.relname ?? ''
}
