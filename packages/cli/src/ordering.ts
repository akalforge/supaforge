/**
 * Statement ordering, with a pluggable backend.
 *
 * A generated migration has to be replayable top to bottom: a type before the
 * table that uses it, a function before the trigger that calls it, a partition
 * attached before the index that must reach it. Getting that wrong produces
 * SQL where every individual statement is valid and the file as a whole fails —
 * or worse, succeeds and leaves objects behind.
 *
 * The built-in sorter derives order from names it recognises in the SQL text.
 * It works, but it only knows the dependencies someone thought to teach it, and
 * has twice needed correcting after a real migration failed.
 *
 * `@supabase/pg-topo` parses the statements with PostgreSQL's own grammar and
 * derives the dependency graph from the parse tree, so it does not need to be
 * taught. It is alpha, so it is opt-in and never fatal: any parse diagnostic,
 * any dropped statement, any thrown error falls back to the built-in ordering.
 * A migration ordered slightly conservatively is fine; a migration missing a
 * statement is not.
 *
 * Enable with SUPAFORGE_ORDERING=pg-topo.
 */
import { orderStatements as orderByHeuristic } from './sql-deps'

export type OrderingBackend = 'builtin' | 'pg-topo'

export interface OrderingResult<T> {
  ordered: T[]
  /** Which backend actually produced this order. */
  backend: OrderingBackend
  /** Why pg-topo was not used, when it was asked for but declined. */
  fellBackBecause?: string
}

export function selectedBackend(env: NodeJS.ProcessEnv = process.env): OrderingBackend {
  return env.SUPAFORGE_ORDERING === 'pg-topo' ? 'pg-topo' : 'builtin'
}

/**
 * Order statements for execution.
 *
 * Returns which backend was used so callers can surface it — an ordering
 * decision that silently changed between runs would be very hard to debug.
 */
export type AnalyzeFn = (stmts: string[]) => Promise<{
  ordered?: unknown[]
  diagnostics?: Array<{ code?: string; message?: string }>
}>

export async function orderForExecution<T>(
  items: T[],
  sqlOf: (item: T) => string,
  backend: OrderingBackend = selectedBackend(),
  /** Injected for tests; production resolves @supabase/pg-topo at run time. */
  analyze?: AnalyzeFn,
): Promise<OrderingResult<T>> {
  if (items.length < 2 || backend === 'builtin') {
    return { ordered: orderByHeuristic(items, sqlOf), backend: 'builtin' }
  }

  try {
    const topo = await orderByPgTopo(items, sqlOf, analyze)
    if (topo.ok) return { ordered: topo.ordered, backend: 'pg-topo' }
    return {
      ordered: orderByHeuristic(items, sqlOf),
      backend: 'builtin',
      fellBackBecause: topo.reason,
    }
  } catch (err) {
    return {
      ordered: orderByHeuristic(items, sqlOf),
      backend: 'builtin',
      fellBackBecause: `pg-topo threw: ${(err as Error).message}`,
    }
  }
}

type TopoOutcome<T> =
  | { ok: true; ordered: T[] }
  | { ok: false; reason: string }

/**
 * Ask pg-topo for an order, and only accept it if it is a faithful permutation
 * of the input.
 *
 * The check matters more than it looks. pg-topo reports parse failures as
 * diagnostics rather than throwing, and a statement it could not parse simply
 * does not appear in `ordered`. Trusting the result blindly would silently drop
 * SQL from a migration — the worst possible failure for this tool.
 */
async function orderByPgTopo<T>(
  items: T[],
  sqlOf: (item: T) => string,
  injected?: AnalyzeFn,
): Promise<TopoOutcome<T>> {
  let analyzeAndSort: AnalyzeFn

  if (injected) {
    analyzeAndSort = injected
  } else try {
    // Optional peer dependency: deliberately not in `dependencies`, so it is
    // absent from a normal install and the specifier cannot be resolved at
    // build time either. The indirection keeps TypeScript from demanding types
    // for a module that may not be there.
    const specifier = '@supabase/pg-topo'
    const mod = await import(/* @vite-ignore */ specifier) as {
      analyzeAndSort: typeof analyzeAndSort
    }
    analyzeAndSort = mod.analyzeAndSort
  } catch {
    return { ok: false, reason: '@supabase/pg-topo is not installed' }
  }

  const texts = items.map(sqlOf)
  const result = await analyzeAndSort(texts)

  const parseErrors = (result.diagnostics ?? []).filter(d => d.code === 'PARSE_ERROR')
  if (parseErrors.length > 0) {
    return { ok: false, reason: `pg-topo could not parse ${parseErrors.length} statement(s)` }
  }

  const orderedTexts = (result.ordered ?? []).map(entry =>
    typeof entry === 'string'
      ? entry
      : String((entry as { sql?: string; text?: string })?.sql
            ?? (entry as { text?: string })?.text ?? ''))

  if (orderedTexts.length !== texts.length) {
    return {
      ok: false,
      reason: `pg-topo returned ${orderedTexts.length} of ${texts.length} statements`,
    }
  }

  // Map back to the original items by text, consuming each match so duplicate
  // statements keep their multiplicity instead of collapsing.
  const pool = new Map<string, T[]>()
  for (const item of items) {
    const key = normalise(sqlOf(item))
    const bucket = pool.get(key)
    if (bucket) bucket.push(item)
    else pool.set(key, [item])
  }

  const ordered: T[] = []
  for (const text of orderedTexts) {
    const bucket = pool.get(normalise(text))
    if (!bucket || bucket.length === 0) {
      return { ok: false, reason: 'pg-topo returned a statement that was not in the input' }
    }
    ordered.push(bucket.shift() as T)
  }

  return { ok: true, ordered }
}

/** Whitespace-insensitive match; pg-topo may re-render trivia. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}
