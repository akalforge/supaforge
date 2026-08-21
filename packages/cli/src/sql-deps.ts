import { escapeRegex } from './utils/strings.js'

/**
 * Dependency analysis for the SQL statements a diff produces.
 *
 * `@dbdiff/cli` emits one statement per difference, in the order it walked the
 * catalogue. That order carries no meaning for execution: a trigger can sort
 * ahead of the function it calls, and applying the set top-to-bottom then fails
 * on a sync that was perfectly valid (issue #48).
 *
 * Everything here works on the SQL text alone, because that is all a fix set
 * is. Two views of a statement are used, and the distinction matters:
 *
 * - the **skeleton** (`sqlSkeleton`), with string and dollar-quoted bodies
 *   removed, for deciding *what a statement is*. A function body containing
 *   the words `CREATE TABLE` must not make its statement look like a table.
 * - the **full text**, for deciding *what a statement mentions*. A view or
 *   function body is exactly where the references to other objects live.
 */

// ─── Execution phases ────────────────────────────────────────────────────────

/**
 * Coarse ordering by object kind, ascending.
 *
 * Postgres requires an object to exist before anything referencing it is
 * created, and requires dependants to be gone before their base object is
 * dropped. Both directions are captured here: dependants are dropped first,
 * base objects are created first, and the destructive drops land at the end.
 *
 * Gaps between the values leave room to slot a kind in later without
 * renumbering the rest.
 */
export const PHASE = {
  /** Triggers, policies, views, indexes — dropped before what they depend on. */
  DROP_DEPENDANT: 10,
  /** Routines, dropped once no trigger still executes them. */
  DROP_ROUTINE: 20,
  /** Types, domains, sequences: no dependencies of their own. */
  CREATE_BASE: 30,
  CREATE_TABLE: 40,
  /** Columns and constraints, needing every table to exist first. */
  ALTER_TABLE: 50,
  /** Before the triggers that execute them and the views that call them. */
  CREATE_ROUTINE: 60,
  CREATE_INDEX: 70,
  CREATE_VIEW: 80,
  /** Anything unrecognised — grants, comments, ownership. */
  OTHER: 85,
  /** Triggers and policies: the last things to be created. */
  CREATE_DEPENDANT: 90,
  /** Row changes, once the structure holding them is in place. */
  DATA: 100,
  DROP_TABLE: 110,
  DROP_BASE: 120,
} as const

/**
 * Phase rules, first match wins.
 *
 * Order is deliberate in two places. The `CREATE` rules precede the `DROP`
 * ones so a merged `DROP FUNCTION` + `CREATE OR REPLACE FUNCTION` pair — how
 * `mergeRoutineReplacements` represents a modified routine — is phased by the
 * object it leaves behind rather than by the drop that opens it. And the
 * dependant kinds precede `FUNCTION` and `TABLE` so `CREATE TRIGGER ... EXECUTE
 * FUNCTION f()` is read as a trigger.
 */
const PHASE_RULES: Array<[RegExp, number]> = [
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, PHASE.CREATE_DEPENDANT],
  [/\bCREATE\s+POLICY\b/i, PHASE.CREATE_DEPENDANT],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i, PHASE.CREATE_VIEW],
  [/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i, PHASE.CREATE_INDEX],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i, PHASE.CREATE_ROUTINE],
  [/\bCREATE\s+(?:TYPE|DOMAIN|SEQUENCE)\b/i, PHASE.CREATE_BASE],
  [/\bCREATE\s+TABLE\b/i, PHASE.CREATE_TABLE],
  [/^\s*ALTER\s+TABLE\b/i, PHASE.ALTER_TABLE],
  [/^\s*DROP\s+(?:TRIGGER|POLICY|INDEX)\b/i, PHASE.DROP_DEPENDANT],
  [/^\s*DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i, PHASE.DROP_DEPENDANT],
  [/^\s*DROP\s+(?:FUNCTION|PROCEDURE)\b/i, PHASE.DROP_ROUTINE],
  [/^\s*DROP\s+TABLE\b/i, PHASE.DROP_TABLE],
  [/^\s*DROP\s+(?:TYPE|DOMAIN|SEQUENCE)\b/i, PHASE.DROP_BASE],
  [/^\s*(?:INSERT|UPDATE|DELETE)\b/i, PHASE.DATA],
]

/** Which execution phase a statement belongs to. */
export function statementPhase(sql: string): number {
  const skeleton = sqlSkeleton(sql)
  for (const [pattern, phase] of PHASE_RULES) {
    if (pattern.test(skeleton)) return phase
  }
  return PHASE.OTHER
}

// ─── Text views ──────────────────────────────────────────────────────────────

/** Dollar-quoted routine bodies: `$$ ... $$`, `$fn$ ... $fn$`. */
const DOLLAR_BODY = /\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g

/**
 * Single-quoted literals, doubled quotes included.
 *
 * Written as the unrolled `'[^']*(?:''[^']*)*'` rather than the equivalent
 * `'(?:[^']|'')*'`: only one alternative can match at any position either way,
 * but the unrolled form has no alternation to backtrack through at all, which
 * matters for a pattern run over SQL from an external process.
 */
const STRING_LITERAL = /'[^']*(?:''[^']*)*'/g

/**
 * A statement with its literals and routine bodies blanked out.
 *
 * Used wherever the *shape* of a statement is being read rather than its
 * contents, so a body that happens to contain DDL keywords cannot be mistaken
 * for the statement's own kind.
 */
export function sqlSkeleton(sql: string): string {
  return sql.replace(DOLLAR_BODY, ' ').replace(STRING_LITERAL, " '' ")
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

/** An optionally schema-qualified, optionally quoted identifier. */
const IDENT = String.raw`(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?`

/** Strip quoting and any schema qualifier, leaving a comparable bare name. */
export function bareName(identifier: string): string {
  const last = identifier.split('.').pop() ?? identifier
  return last.trim().replace(/^"|"$/g, '').toLowerCase()
}

/** `CREATE [OR REPLACE] [UNIQUE|MATERIALIZED|TEMP] <kind> [IF NOT EXISTS] <name>` */
const CREATES = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+|MATERIALIZED\s+|TEMP(?:ORARY)?\s+|CONSTRAINT\s+){0,2}` +
    String.raw`(?:TABLE|VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|INDEX|TRIGGER|POLICY)\s+` +
    String.raw`(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`,
  'gi',
)

/**
 * The bare names of every object a statement creates.
 *
 * Read off the skeleton so a routine body that creates something locally does
 * not advertise it to the rest of the batch. A merged DROP + CREATE pair
 * reports the name it recreates, which is what other statements need.
 */
export function providedNames(sql: string): string[] {
  const names = new Set<string>()
  for (const match of sqlSkeleton(sql).matchAll(CREATES)) {
    names.add(bareName(match[1]))
  }
  return [...names]
}

/**
 * A statement that only removes things.
 *
 * These take no "must run after a CREATE" edges: `DROP TABLE orders` mentions
 * `orders` but has to run *after* everything using it, not after its creation —
 * an ordering the phases already express. Recognised by creating nothing rather
 * than by the leading keyword alone, so a merged DROP + CREATE pair is
 * correctly excluded.
 */
function isDropOnly(sql: string, provides: string[]): boolean {
  return provides.length === 0 && /^\s*DROP\b/i.test(sql)
}

// ─── Table references ────────────────────────────────────────────────────────

/** `FROM`/`JOIN`/`INTO`/`UPDATE`/`REFERENCES` each introduce a table name. */
const BODY_TABLE_REF = new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES)\s+(?:ONLY\s+)?(${IDENT})`, 'gi')

/**
 * The `ON <table>` of an index, trigger or policy.
 *
 * Anchored on what follows the name so a join condition (`ON a.id = b.id`) is
 * not read as a table reference — the trailing keyword or punctuation is what
 * separates the two forms.
 */
const ON_TABLE_REF = new RegExp(String.raw`\bON\s+(?:ONLY\s+)?(${IDENT})\s*(?:USING\b|FOR\b|AS\b|TO\b|\(|;|$)`, 'gi')

/** The table an `ALTER`/`DROP TABLE` acts on. */
const TARGET_TABLE_REF = new RegExp(
  String.raw`^\s*(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})`,
  'gi',
)

/**
 * Keywords that can follow a reference keyword without naming a table.
 *
 * `UPDATE ON public.orders` in a trigger definition is the one that matters:
 * without this, the word `ON` would be collected as a table called "on".
 */
const NOT_A_TABLE = new Set([
  'on', 'of', 'from', 'join', 'into', 'select', 'lateral', 'only', 'conflict',
  'delete', 'update', 'insert', 'constraint', 'each', 'row', 'statement', 'values',
])

/**
 * The tables a statement reads, writes or hangs off, as bare lowercase names.
 *
 * Deliberately over-inclusive: it reads the full text, bodies included, so a
 * view or function that touches an out-of-scope table is caught. A false
 * positive costs a fix that is skipped with a reason the user can read, which
 * is the safer direction — a false negative is a statement that runs and fails
 * (issue #48).
 */
export function referencedTables(sql: string): string[] {
  const names = new Set<string>()
  for (const pattern of [BODY_TABLE_REF, ON_TABLE_REF, TARGET_TABLE_REF]) {
    for (const match of sql.matchAll(pattern)) {
      const name = bareName(match[1])
      if (!NOT_A_TABLE.has(name)) names.add(name)
    }
  }
  return [...names]
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/** One statement, with everything the sort needs precomputed. */
interface Node {
  phase: number
  /** Indices that must execute before this one. */
  after: Set<number>
}

/**
 * Match `name` used as a whole identifier, quoted or not, schema-qualified or
 * not. Built once per name rather than per comparison — a large fix set is
 * thousands of pairings.
 */
function identifierMatcher(name: string): RegExp {
  return new RegExp(String.raw`(?<![\w$])"?${escapeRegex(name)}"?(?![\w$])`, 'i')
}

/**
 * Build the "must run after" edges between statements.
 *
 * One rule covers every object kind: if a statement creates something named
 * `n`, any other statement mentioning `n` is assumed to need it. That catches
 * the reported trigger-before-function case, and equally a view over a new
 * table, an index on one, or a column default that calls a new function.
 */
function linkDependencies(nodes: Node[], texts: string[], provides: string[][]): void {
  const droppers = texts.map((sql, i) => isDropOnly(sql, provides[i]))

  for (let provider = 0; provider < nodes.length; provider++) {
    for (const name of provides[provider]) {
      const matcher = identifierMatcher(name)
      for (let consumer = 0; consumer < nodes.length; consumer++) {
        if (consumer === provider || droppers[consumer]) continue
        if (matcher.test(texts[consumer])) nodes[consumer].after.add(provider)
      }
    }
  }
}

/**
 * Pick the next statement to run: the one whose dependencies are all satisfied,
 * earliest by phase, then by the order the diff reported it.
 *
 * Falls back to the lowest remaining index when nothing is ready, which happens
 * only if the edges form a cycle — mutually referencing tables, or a name that
 * reads like two different objects. Emitting those in their original order is
 * no worse than the behaviour this replaces.
 */
function nextReady(remaining: number[], nodes: Node[], done: Set<number>): number {
  let best: number | undefined
  for (const index of remaining) {
    const ready = [...nodes[index].after].every(dep => done.has(dep))
    if (!ready) continue
    if (best === undefined || nodes[index].phase < nodes[best].phase) best = index
  }
  return best ?? remaining[0]
}

/**
 * Sort a fix set into an order Postgres can execute in a single pass.
 *
 * Stable within a phase: statements that neither depend on one another nor
 * differ in kind come out in the order the diff reported them, so the plan
 * stays recognisable against `--detail`.
 */
export function orderStatements<T>(items: T[], sqlOf: (item: T) => string): T[] {
  if (items.length < 2) return [...items]

  const texts = items.map(sqlOf)
  const provides = texts.map(providedNames)
  const nodes: Node[] = texts.map(sql => ({ phase: statementPhase(sql), after: new Set<number>() }))

  linkDependencies(nodes, texts, provides)

  const done = new Set<number>()
  let remaining = texts.map((_, i) => i)
  const ordered: T[] = []

  while (remaining.length > 0) {
    const next = nextReady(remaining, nodes, done)
    ordered.push(items[next])
    done.add(next)
    remaining = remaining.filter(i => i !== next)
  }

  return ordered
}
