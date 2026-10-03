import { splitSqlStatements } from './utils/sql-split.js'
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
  /**
   * Routines, dropped once nothing calls them: the triggers, views and
   * policies come off first, and so do the column defaults, CHECK constraints,
   * expression indexes and tables — all of which can call one, and were still
   * in place when routines were dropped at the start (`cannot drop function
   * ... because other objects depend on it`). Before the types a routine's
   * signature can use.
   */
  DROP_ROUTINE: 115,
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
  // A column type change grouped with the dependants dbdiff drops and
  // recreates around it (see groupColumnTypeChanges) runs as the column change
  // it is — before a foreign key that needs the new type, for one — not as the
  // view or policy it happens to recreate.
  [/^\s*DROP\s+(?:POLICY|TRIGGER|(?:MATERIALIZED\s+)?VIEW)\b[\s\S]*\bALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, PHASE.ALTER_TABLE],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, PHASE.CREATE_DEPENDANT],
  [/\bCREATE\s+POLICY\b/i, PHASE.CREATE_DEPENDANT],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i, PHASE.CREATE_VIEW],
  [/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i, PHASE.CREATE_INDEX],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i, PHASE.CREATE_ROUTINE],
  [/\bCREATE\s+(?:TYPE|DOMAIN|SEQUENCE)\b/i, PHASE.CREATE_BASE],
  [/\bCREATE\s+TABLE\b/i, PHASE.CREATE_TABLE],
  // A serial default removed with its sequence, as one change: the sequence
  // can only go once every table defaulting to it has, so the change runs
  // with the other sequence drops, not as the ALTER TABLE it opens with —
  // which dropped it while a table still to be dropped used it ("cannot drop
  // sequence ... because other objects depend on it").
  [/^\s*ALTER\s+TABLE\b[\s\S]*;\s*DROP\s+SEQUENCE\b/i, PHASE.DROP_BASE],
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

/** `-- to end of line`, and `/* ... *\/` across lines. */
const LINE_COMMENT = /--[^\n]*/g
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g

/**
 * A statement with its literals and routine bodies blanked out.
 *
 * Used wherever the *shape* of a statement is being read rather than its
 * contents, so a body that happens to contain DDL keywords cannot be mistaken
 * for the statement's own kind.
 */
export function sqlSkeleton(sql: string): string {
  return sql
    .replace(DOLLAR_BODY, ' ')
    .replace(STRING_LITERAL, " '' ")
    // Comments last, so a `--` inside a literal has already been blanked and
    // cannot swallow the rest of the line. dbdiff's own migrations are full of
    // `-- Recreate trigger` lines, and a commented-out CREATE would otherwise
    // read as a real one: enough to make the duplicate-fix check believe an
    // object exists and drop the statement that genuinely creates it.
    .replace(LINE_COMMENT, ' ')
    .replace(BLOCK_COMMENT, ' ')
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
/**
 * The policies a statement creates, as `table.policy` in lower case.
 *
 * Two layers can now legitimately produce the same `CREATE POLICY`. The schema
 * check gets its SQL from `@dbdiff/cli`, which models RLS policies as of
 * 3.0.0-rc.10, and the rls check has always written its own. Applied together
 * the second fails with "policy ... already exists" and takes the whole
 * transaction with it, so the duplicate has to be recognised before it runs.
 *
 * Matched on the pair that identifies a policy in Postgres — its name and its
 * table — because the two layers spell the same policy differently: one emits
 * `ON "t"`, the other `ON "public"."t"` across several lines. The schema
 * qualifier is dropped for the same reason `referencedTables` drops it.
 */
export function createdPolicies(sql: string): string[] {
  const out: string[] = []
  const re = /CREATE\s+POLICY\s+("[^"]+"|[A-Za-z_][\w$]*)\s+ON\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi
  for (const m of sqlSkeleton(sql).matchAll(re)) {
    out.push(`${bareName(m[2])}.${bareName(m[1])}`)
  }
  return out
}

/**
 * True when creating policies is all this statement does.
 *
 * The schema check bundles its policy alongside the table and the ENABLE ROW
 * LEVEL SECURITY that makes it mean anything, so that statement must never be
 * dropped as a duplicate — only a statement whose sole purpose is the policy can
 * be. Anything left once the CREATE POLICY statements are removed counts, which
 * errs towards keeping a statement rather than losing DDL.
 */
/**
 * The policies a statement drops, keyed as `createdPolicies` keys them.
 *
 * Needed to tell a policy being *removed* from one being *replaced*: the RLS
 * check renders a modified policy as `DROP POLICY` + `CREATE POLICY` for the
 * same name, and that is not a loss of access control (issue #88).
 */
export function droppedPolicies(sql: string): string[] {
  const out: string[] = []
  const re = /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)\s+ON\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi
  for (const m of sqlSkeleton(sql).matchAll(re)) {
    out.push(`${bareName(m[2])}.${bareName(m[1])}`)
  }
  return out
}

/**
 * Policies this statement drops without putting back.
 *
 * Dropping a policy is not recoverable from the schema the way dropping a view
 * or a function is, and a dropped RESTRICTIVE policy *grants* access rather
 * than removing it — so it belongs behind the same gate as losing rows.
 */
export function policiesRemoved(sql: string): string[] {
  const recreated = new Set(createdPolicies(sql))
  return droppedPolicies(sql).filter(key => !recreated.has(key))
}

export function createsOnlyPolicies(sql: string): boolean {
  if (createdPolicies(sql).length === 0) return false
  const withoutPolicies = sqlSkeleton(sql)
    .replace(/CREATE\s+POLICY[\s\S]*?(?=;|$)/gi, '')
    .replace(/DROP\s+POLICY[\s\S]*?(?=;|$)/gi, '')
  return !/[A-Za-z]/.test(withoutPolicies)
}

/**
 * The triggers a statement creates, keyed the way Postgres identifies one.
 *
 * Same collision as policies, one layer along. The schema check's SQL creates
 * webhook triggers — they are ordinary triggers as far as dbdiff is concerned —
 * and since issue #77 the webhooks check emits the server's own
 * `pg_get_triggerdef()` for the same trigger. Applied together the second fails
 * with `trigger "x" for relation "y" already exists`, and the transactional
 * apply discards every other fix with it: the reported symptom was a full
 * `diff --apply` rolling back six correct schema fixes.
 *
 * A trigger name is unique per table, not per schema, so the table belongs in
 * the key — which is also why the webhooks check now keys its own entries that
 * way. The schema qualifier is dropped for the same reason `referencedTables`
 * drops it: the two layers spell the same table differently.
 */
export function createdTriggers(sql: string): string[] {
  const out: string[] = []
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+("[^"]+"|[A-Za-z_][\w$]*)[\s\S]*?\sON\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi
  for (const m of sqlSkeleton(sql).matchAll(re)) {
    out.push(`${bareName(m[2])}.${bareName(m[1])}`)
  }
  return out
}

/**
 * True when creating triggers is all this statement does.
 *
 * The same guard as `createsOnlyPolicies`: the schema check bundles a trigger
 * with the table and function it needs, and dropping that as a duplicate would
 * lose the DDL around it. A leading DROP TRIGGER is expected — the webhooks
 * check emits one before recreating a modified webhook — so it does not count
 * as doing something else.
 */
export function createsOnlyTriggers(sql: string): boolean {
  if (createdTriggers(sql).length === 0) return false
  const withoutTriggers = sqlSkeleton(sql)
    .replace(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER[\s\S]*?(?=;|$)/gi, '')
    .replace(/DROP\s+TRIGGER[\s\S]*?(?=;|$)/gi, '')
  return !/[A-Za-z]/.test(withoutTriggers)
}

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
  /** The fix's position in the order its producer wrote it, when that order is to be kept. */
  rank?: number
  phase: number
  /** Indices that must execute before this one. */
  after: Set<number>
}

/**
 * Match `name` used as a whole identifier, quoted or not, schema-qualified or
 * not. Built once per name rather than per comparison — a large fix set is
 * thousands of pairings.
 */
/** Matches `name` as a whole identifier, quoted or not. */
export function identifierMatcher(name: string): RegExp {
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
  // What a statement *uses* is what it mentions outside its DROPs. A column
  // type change grouped with the dependants it drops and recreates mentions
  // the policy it drops, and was made to wait for the fix that creates that
  // policy — which then ran first, against the column's old type.
  const uses = texts.map(withoutDropStatements)

  for (let provider = 0; provider < nodes.length; provider++) {
    for (const name of provides[provider]) {
      const matcher = identifierMatcher(name)
      for (let consumer = 0; consumer < nodes.length; consumer++) {
        if (consumer === provider || droppers[consumer]) continue
        // A statement that creates `name` itself does not need another's:
        // two column changes under one view each recreate it, and linking
        // them both ways made a cycle, which the fallback resolves by
        // report order rather than by phase.
        if (provides[consumer].includes(name)) continue
        if (matcher.test(uses[consumer])) nodes[consumer].after.add(provider)
      }
    }
  }
}

/** A statement batch with its DROP statements taken out. */
function withoutDropStatements(sql: string): string {
  if (!/\bDROP\b/i.test(sql)) return sql
  return splitSqlStatements(sql).filter(s => !/^\s*DROP\b/i.test(sqlSkeleton(s))).join('\n')
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
    if (!isSatisfied(nodes[index].after, done)) continue
    if (best === undefined || runsBefore(nodes[index], nodes[best])) best = index
  }
  return best ?? remaining[0]
}

/**
 * Which of two ready statements goes first.
 *
 * Two fixes that both carry a rank — DBDiff's own, in the order DBDiff wrote
 * them — keep that order: DBDiff orders its migration from the catalog, which
 * knows what depends on what, and this module can only guess from the text.
 * Re-sorting them by kind here dropped a serial's sequence before a table
 * still using it, though DBDiff had them the right way round. Anything else —
 * a policy from the RLS check, a webhook, a row — is placed by its phase. A
 * dependency read from the names still comes first either way: `after` is
 * satisfied before any of this is asked.
 */
function runsBefore(a: Node, b: Node): boolean {
  if (a.rank !== undefined && b.rank !== undefined) return a.rank < b.rank
  return a.phase < b.phase
}

/** Have all of `after` already run? Iterated rather than spread — this is the
 * inner loop of the sort, and a large fix set runs it thousands of times. */
function isSatisfied(after: Set<number>, done: Set<number>): boolean {
  for (const dep of after) {
    if (!done.has(dep)) return false
  }
  return true
}

/**
 * Sort a fix set into an order Postgres can execute in a single pass.
 *
 * Stable within a phase: statements that neither depend on one another nor
 * differ in kind come out in the order the diff reported them, so the plan
 * stays recognisable against `--detail`.
 */
export function orderStatements<T>(
  items: T[],
  sqlOf: (item: T) => string,
  rankOf: (item: T) => number | undefined = () => undefined,
): T[] {
  if (items.length < 2) return [...items]

  const texts = items.map(sqlOf)
  const provides = texts.map(providedNames)
  const nodes: Node[] = texts.map((sql, i) => ({ phase: statementPhase(sql), rank: rankOf(items[i]), after: new Set<number>() }))

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

// ─── Statement subject ───────────────────────────────────────────────────────

/** A schema-qualified object name, unquoted. `schema` is null when unqualified. */
export interface QualifiedName {
  schema: string | null
  name: string
}

function splitQualified(identifier: string): QualifiedName {
  const parts = identifier.match(/"[^"]+"|[\w$]+/g) ?? []
  const clean = parts.map(p => p.replace(/^"|"$/g, ''))
  if (clean.length >= 2) return { schema: clean[clean.length - 2], name: clean[clean.length - 1] }
  return { schema: null, name: clean[0] ?? '' }
}

/** A possibly three-part name (`schema.table.column`), as COMMENT ON COLUMN takes. */
const IDENT3 = String.raw`(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+)){0,2}`

const OBJECT_KIND = String.raw`(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE|FUNCTION|PROCEDURE|ROUTINE|AGGREGATE|SEQUENCE|TYPE|DOMAIN|INDEX|SCHEMA)`

/**
 * Subject patterns, most specific first, each with what its capture names:
 * an object, a schema, or a `schema.table.column`. For a trigger, policy,
 * rule or index the object is the table it belongs to rather than its own
 * name, since that is what owns it.
 */
const SUBJECT_RULES: Array<[RegExp, 'object' | 'schema' | 'column']> = [
  // CREATE/DROP/ALTER TRIGGER|POLICY name ... ON <table>
  [new RegExp(String.raw`^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?|DROP\s+|ALTER\s+)(?:TRIGGER|POLICY)\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"|[\w$]+)[\s\S]*?\bON\s+(?:ONLY\s+)?(${IDENT})`, 'i'), 'object'],
  // CREATE RULE name AS ON <event> TO <table>
  [new RegExp(String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?RULE\s+(?:"[^"]+"|[\w$]+)\s+AS\s+ON\s+\w+\s+TO\s+(${IDENT})`, 'i'), 'object'],
  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] <table>
  [new RegExp(String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?(${IDENT})`, 'i'), 'object'],
  // COMMENT ON TRIGGER|POLICY|RULE|CONSTRAINT name ON <table>
  [new RegExp(String.raw`^\s*COMMENT\s+ON\s+(?:TRIGGER|POLICY|RULE|CONSTRAINT)\s+(?:"[^"]+"|[\w$]+)\s+ON\s+(?:DOMAIN\s+)?(${IDENT})`, 'i'), 'object'],
  [new RegExp(String.raw`^\s*COMMENT\s+ON\s+COLUMN\s+(${IDENT3})`, 'i'), 'column'],
  [new RegExp(String.raw`^\s*COMMENT\s+ON\s+SCHEMA\s+((?:"[^"]+"|[\w$]+))`, 'i'), 'schema'],
  [new RegExp(String.raw`^\s*COMMENT\s+ON\s+${OBJECT_KIND}\s+(${IDENT})`, 'i'), 'object'],
  // GRANT/REVOKE ... ON SCHEMA <schema> | ON ALL <kind> IN SCHEMA <schema> | ON [kind] <name>
  [new RegExp(String.raw`^\s*(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+SCHEMA\s+((?:"[^"]+"|[\w$]+))`, 'i'), 'schema'],
  [new RegExp(String.raw`^\s*(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+ALL\s+\w+\s+IN\s+SCHEMA\s+((?:"[^"]+"|[\w$]+))`, 'i'), 'schema'],
  [new RegExp(String.raw`^\s*(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+(?:${OBJECT_KIND}\s+)?(${IDENT})`, 'i'), 'object'],
  // ALTER DEFAULT PRIVILEGES ... IN SCHEMA <schema>
  [new RegExp(String.raw`^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\bIN\s+SCHEMA\s+((?:"[^"]+"|[\w$]+))`, 'i'), 'schema'],
  // CREATE|ALTER|DROP SCHEMA <schema>
  [new RegExp(String.raw`^\s*(?:CREATE|ALTER|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?((?:"[^"]+"|[\w$]+))`, 'i'), 'schema'],
  // CREATE [OR REPLACE] [modifiers] <kind> [IF NOT EXISTS] <name>
  [new RegExp(String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|RECURSIVE)\s+)*${OBJECT_KIND}\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'i'), 'object'],
  // ALTER|DROP <kind> [IF EXISTS] [ONLY] <name>
  [new RegExp(String.raw`^\s*(?:ALTER|DROP)\s+${OBJECT_KIND}\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})`, 'i'), 'object'],
]

/**
 * The object a statement acts on — its *subject*, not every name it mentions.
 *
 * `CREATE TRIGGER t ... ON public.orders EXECUTE FUNCTION
 * supabase_functions.http_request(...)` acts on `public.orders`: it mentions a
 * platform schema, but what it creates belongs to the project. Deciding
 * ownership by mention skipped every Database Webhook on restore, and every
 * view reading `cron` or `vault`. The subject is what decides who owns a
 * statement's result.
 *
 * For `COMMENT ON COLUMN s.t.c` the subject is the table `s.t`; for a
 * schema-level statement (`CREATE SCHEMA x`, `GRANT ... ON SCHEMA x`,
 * `... IN SCHEMA x`) it is `{ schema: x, name: x }`. Undefined when the
 * statement's shape is not one of these.
 */
export function statementSubject(sql: string): QualifiedName | undefined {
  const skeleton = sqlSkeleton(sql)

  for (const [rule, captures] of SUBJECT_RULES) {
    const match = rule.exec(skeleton)
    if (!match) continue

    const parts = (match[1].match(/"[^"]+"|[\w$]+/g) ?? []).map(p => p.replace(/^"|"$/g, ''))
    if (captures === 'schema') return { schema: parts[0], name: parts[0] }
    if (captures === 'column') {
      return parts.length >= 3
        ? { schema: parts[parts.length - 3], name: parts[parts.length - 2] }
        : { schema: null, name: parts[0] ?? '' }
    }
    return splitQualified(match[1])
  }

  return undefined
}

/**
 * The policies (`table.policy`) a fix consists of, when it is nothing but
 * CREATE and DROP POLICY statements; otherwise null.
 */
export function policyOnlyKeys(sql: string | undefined): string[] | null {
  if (!sql) return null
  const statements = splitSqlStatements(sql).filter(s => sqlSkeleton(s).trim() !== '')
  if (statements.length === 0) return null
  if (!statements.every(s => /^\s*(?:CREATE|DROP)\s+POLICY\b/i.test(sqlSkeleton(s)))) return null
  return [...new Set([...createdPolicies(sql), ...droppedPolicies(sql)])]
}

/** Role specifications that are keywords rather than roles, so never created. */
const ROLE_KEYWORDS = new Set(['public', 'current_user', 'current_role', 'session_user'])

/**
 * Every role a statement grants to or scopes a policy to.
 *
 * A restore creates them first where the target lacks them, and `--prove`
 * declines to run when the server lacks them, since creating a role is never
 * confined to a throwaway database.
 *
 * A snapshot's `roles.sql` grants to Supabase's Data API roles — `anon`,
 * `authenticated`, `service_role` — and the usual restore target is plain
 * PostgreSQL, where none of them exist. A policy names roles too, and the
 * schema dump and the RLS layer both replay policies long before the roles
 * layer's grants: `CREATE POLICY … TO service_role` into plain PostgreSQL
 * failed with `role "service_role" does not exist` and, in one transaction,
 * rolled the whole restore back. Every role in the list is returned, not just
 * the first, since a policy for `authenticated, service_role` needs both.
 *
 * Read off the skeleton, so a role named inside a function body or a string
 * literal is not mistaken for one. `PUBLIC` and `CURRENT_USER` are keywords,
 * not roles, and a `pg_` role is built in: none of them can be created.
 * `ALTER POLICY … RENAME TO` names a policy, not a role.
 */
export function rolesNamedBy(sql: string): string[] {
  const skeleton = sqlSkeleton(sql)
  const list =
    /^\s*GRANT\b[\s\S]*?\bTO\s+([\s\S]*?)(?=\s+WITH\b|\s+GRANTED\s+BY\b|\s*;|\s*$)/i.exec(skeleton)
    ?? /^\s*(?:CREATE|ALTER)\s+POLICY\b(?![\s\S]*\bRENAME\s+TO\b)[\s\S]*?\bTO\s+([\s\S]*?)(?=\s+USING\b|\s+WITH\s+CHECK\b|\s*;|\s*$)/i.exec(skeleton)
  if (!list) return []

  const roles = (list[1].match(/"(?:[^"]|"")+"|[\w$]+/g) ?? [])
    // Unquoted, PostgreSQL folds the name to lower case.
    .map(r => r.startsWith('"') ? r.slice(1, -1).replace(/""/g, '"') : r.toLowerCase())
    .filter(r => !ROLE_KEYWORDS.has(r.toLowerCase()) && !r.startsWith('pg_'))
  return [...new Set(roles)]
}
