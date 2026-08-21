import type { SupaForgeConfig } from '../types/config.js'
import { parseFlagList, globToRegExp } from './strings.js'

/**
 * Which tables a diff should look at.
 *
 * Empty/undefined means "everything", which is the default and what every
 * existing caller gets. Patterns are passed to @dbdiff/cli verbatim, so its
 * glob support (`*`, `?`) works here too.
 */
export interface TableFilter {
  /** Only compare these. Undefined means all. */
  tables?: string[]
  /** Never compare these. Applied after `tables`. */
  excludeTables?: string[]
}

/**
 * Split a repeatable table flag into individual patterns.
 *
 * `--tables=a,b --tables=c` and `--tables=a --tables=b --tables=c` mean the
 * same thing. The splitting itself is shared with every other repeatable list
 * flag; this name is what the table call sites read by.
 */
export const parseTableList = parseFlagList

/**
 * Resolve the effective filter from config and CLI flags.
 *
 * `tables` is an *override*: `--tables=orders` means "only orders", so a
 * broader list in config must not widen it back out. `excludeTables` is a
 * *union*: an exclusion is a safety rail, and the two sources agreeing to
 * exclude more is never the surprising direction. This mirrors how `--skip`
 * already merges with `checks.exclude`.
 *
 * Tolerates a malformed config — a non-array yields no filter rather than
 * throwing, so a bad config compares everything instead of taking the scan
 * down.
 */
export function resolveTableFilter(
  config: SupaForgeConfig | undefined,
  cli: { tables?: string[]; excludeTables?: string[] } = {},
): TableFilter {
  const cliTables = parseTableList(cli.tables)
  const cliExclude = parseTableList(cli.excludeTables)

  const configTables = Array.isArray(config?.checks?.tables) ? config.checks.tables : []
  const configExclude = Array.isArray(config?.checks?.excludeTables) ? config.checks.excludeTables : []

  const tables = cliTables.length > 0 ? cliTables : parseTableList(configTables)
  const excludeTables = [...new Set([...parseTableList(configExclude), ...cliExclude])]

  const filter: TableFilter = {}
  if (tables.length > 0) filter.tables = tables
  if (excludeTables.length > 0) filter.excludeTables = excludeTables
  return filter
}

/** True when the filter would narrow anything. */
export function isFiltered(filter: TableFilter | undefined): boolean {
  return Boolean(filter?.tables?.length || filter?.excludeTables?.length)
}

/**
 * One line describing what the run is scoped to, or null when it is not
 * scoped at all.
 *
 * Printed before the scan because a narrowed run must never look like a full
 * one — particularly with `--apply`, where the difference is which statements
 * get executed. It also names the layers the filter reaches: a table is a
 * concept the schema and data checks have and the others do not, so `diff
 * --tables=orders` still compares every RLS policy and storage bucket.
 */
export function describeTableFilter(filter: TableFilter | undefined): string | null {
  if (!isFiltered(filter)) return null
  const parts: string[] = []
  if (filter?.tables?.length) parts.push(`only ${filter.tables.join(', ')}`)
  if (filter?.excludeTables?.length) parts.push(`excluding ${filter.excludeTables.join(', ')}`)
  return `Scoped to ${parts.join(', ')} — applies to the schema and data checks; other layers are unfiltered.`
}

/**
 * Does `name` match a @dbdiff/cli-style glob pattern?
 *
 * Only `*` and `?` are special, matching dbdiff's own syntax. Used to narrow
 * the Reference Data table list locally, since that check picks its tables
 * from config before dbdiff is invoked and so cannot rely on `--tables` alone.
 *
 * Comparison is case-insensitive and tolerant of a schema qualifier: a pattern
 * of `orders` matches `public.orders`, because that is what a user means when
 * they name a table without a schema.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const candidates = [name.toLowerCase()]
  const dot = name.indexOf('.')
  if (dot !== -1) candidates.push(name.slice(dot + 1).toLowerCase())

  const rx = globToRegExp(pattern.toLowerCase())
  return candidates.some(c => rx.test(c))
}

/**
 * Apply a filter to a concrete list of table names.
 *
 * Include first, then exclude — so `--tables='billing_*' --exclude-tables='*_audit'`
 * reads left to right the way it is written.
 */
export function applyTableFilter(names: string[], filter: TableFilter | undefined): string[] {
  if (!isFiltered(filter)) return names

  let out = names
  if (filter?.tables?.length) {
    out = out.filter(n => filter.tables!.some(p => matchesPattern(n, p)))
  }
  if (filter?.excludeTables?.length) {
    out = out.filter(n => !filter.excludeTables!.some(p => matchesPattern(n, p)))
  }
  return out
}
