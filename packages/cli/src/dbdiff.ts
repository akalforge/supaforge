import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, unlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DriftIssue } from './types/drift'
import { errMsg, friendlyDbError, DiagnosticError } from './utils/error'
import { DBDIFF_EXEC_TIMEOUT_MS, DBDIFF_MAX_BUFFER } from './constants'

const execFileAsync = promisify(execFile)

export interface DbDiffOptions {
  sourceUrl: string
  targetUrl: string
  type: 'schema' | 'data' | 'all'
  include: 'up' | 'down' | 'both'
  tables?: string[]
  ignoreTables?: string[]
  /** Schemas to exclude — converted to --ignore-tables=schema.* glob patterns. */
  ignoreSchemas?: string[]
  /**
   * Seconds before the diff is abandoned, from the target environment's
   * checks.schema.timeout. SUPAFORGE_DBDIFF_TIMEOUT still wins over this.
   */
  timeoutSeconds?: number
  /**
   * Called as dbdiff reports progress on individual tables, so a long schema
   * diff reads as working rather than hung (issue #29).
   */
  onProgress?: (progress: { table: string; tablesSeen: number }) => void
}

export interface DbDiffResult {
  up: string
  down: string
}

/**
 * Resolve the @dbdiff/cli binary path from node_modules.
 *
 * Uses createRequire to locate the installed package, then returns
 * the path to `bin/dbdiff.js`. Falls back to 'npx' if the package
 * is not installed locally (e.g. global install).
 */
export function resolveDbDiffBin(): { command: string; prefixArgs: string[] } {
  try {
    const require = createRequire(import.meta.url)
    const binPath = require.resolve('@dbdiff/cli/bin/dbdiff.js')
    return { command: process.execPath, prefixArgs: [binPath] }
  } catch {
    // Fallback: try npx for global installs
    return { command: 'npx', prefixArgs: ['@dbdiff/cli'] }
  }
}

/**
 * Run @dbdiff/cli and parse UP/DOWN SQL output.
 *
 * Writes to a temp file via --output, reads it back, then parses
 * the `-- ==================== UP ====================` /
 * `-- ==================== DOWN ====================` markers.
 *
 * When @dbdiff/cli is not installed, throws with a clear message.
 */
/**
 * Resolve the effective dbdiff timeout (ms).
 *
 * Honours the SUPAFORGE_DBDIFF_TIMEOUT environment variable (in seconds) so
 * users with very large schemas can raise the ceiling without a code change.
 * Falls back to DBDIFF_EXEC_TIMEOUT_MS.
 */
export function resolveDbDiffTimeoutMs(configuredSeconds?: number): number {
  // Precedence: env var > per-environment config > default. The env var is the
  // runtime escape hatch, so it has to beat a committed config value.
  const raw = process.env.SUPAFORGE_DBDIFF_TIMEOUT
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  }
  if (Number.isFinite(configuredSeconds) && (configuredSeconds as number) > 0) {
    return Math.round((configuredSeconds as number) * 1000)
  }
  return DBDIFF_EXEC_TIMEOUT_MS
}

/**
 * dbdiff logs a line per table as it works. Recognising them turns a silent
 * multi-minute spinner into visible progress.
 *
 * Matches both the per-table diff line and the batch pre-scan summary, and is
 * tolerant of the ANSI colour codes dbdiff emits.
 */
const DBDIFF_TABLE_LINE = /calculating schema diff for table [`"']?([\w.$]+)/i

export function parseDbDiffProgress(line: string): string | null {
  return DBDIFF_TABLE_LINE.exec(line)?.[1] ?? null
}

/**
 * Resolve the PHP memory limit to hand to @dbdiff/cli, if any.
 *
 * @dbdiff/cli caps itself at 1G by default, which is ample for most Supabase
 * projects but can be exceeded by a very large schema or a wide data diff.
 * SUPAFORGE_DBDIFF_MEMORY passes straight through to `--memory-limit`, taking
 * the same values dbdiff accepts: "512M", "2G", or "-1" for unlimited.
 *
 * Returns undefined when unset or malformed, leaving dbdiff on its own default
 * rather than forwarding a value it would reject.
 */
export function resolveDbDiffMemoryLimit(): string | undefined {
  const raw = process.env.SUPAFORGE_DBDIFF_MEMORY?.trim()
  if (!raw) return undefined
  return /^-?\d+[KMG]?$/i.test(raw) ? raw : undefined
}

/**
 * Strip @dbdiff/cli progress / spinner noise from captured output.
 *
 * dbdiff logs informational lines such as "ℹ Now generating UP migration"
 * to stdout while it works. When the process is killed (e.g. on timeout)
 * that last progress line is the only thing in the buffer — surfacing it as
 * the "error" is misleading. Drop any line that begins with a known
 * info/spinner glyph and keep only genuine error-looking content.
 */
const DBDIFF_NOISE_LINE = /^\s*[ℹ✔✓⚠⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u

export function stripDbDiffNoise(text: string): string {
  return text
    .split('\n')
    .filter(line => line.trim() !== '' && !DBDIFF_NOISE_LINE.test(line))
    .join('\n')
    .trim()
}

/**
 * Build the full @dbdiff/cli argument list for a diff run.
 *
 * Split out of runDbDiff() so the flag surface is one readable unit and can be
 * asserted directly in tests, rather than only through a spawned process.
 */
export function buildDbDiffArgs(options: DbDiffOptions, outputFile: string): string[] {
  const args = [
    'diff',
    `--server1-url=${options.sourceUrl}`,
    `--server2-url=${options.targetUrl}`,
    `--type=${options.type}`,
    // Was hardcoded to 'both', silently ignoring options.include. Every caller
    // passes 'both' (sqlToIssues pairs each UP statement with its DOWN
    // counterpart, so it needs both directions), but the option was part of the
    // public interface and did nothing.
    `--include=${options.include}`,
    '--nocomments',
    // @dbdiff/cli >= 3.0.0-rc.3 refuses to emit a migration containing
    // DROP TABLE or DROP COLUMN unless this is passed, exiting non-zero and
    // writing no output file. SupaForge is a *detection* tool: an extra table
    // or column on the target is the single most common form of drift, and it
    // has to be reported rather than turned into a hard failure. The safety
    // gate belongs at apply time instead — see isDestructiveSql()/promote(),
    // which skip these statements unless the user opts in explicitly.
    '--allow-destructive',
    `--output=${outputFile}`,
  ]

  const memoryLimit = resolveDbDiffMemoryLimit()
  if (memoryLimit) {
    args.push(`--memory-limit=${memoryLimit}`)
  }

  // Both --tables and --ignore-tables take one comma-separated list, so the
  // ignoreSchemas globs (auth.*, storage.*) have to merge into any existing
  // --ignore-tables value rather than be appended as a second flag.
  const ignore = [
    ...(options.ignoreTables ?? []),
    ...(options.ignoreSchemas ?? []).map(s => `${s}.*`),
  ]

  if (options.tables?.length) {
    args.push(`--tables=${options.tables.join(',')}`)
  }
  if (ignore.length) {
    args.push(`--ignore-tables=${ignore.join(',')}`)
  }

  return args
}

/**
 * Forward dbdiff's per-table log lines to a progress callback.
 *
 * Entirely best-effort: any failure here must never affect the diff itself,
 * so every step is guarded. A missing stdout (possible if the process dies
 * immediately) simply means no progress is reported.
 */
function attachProgress(
  running: { child?: { stdout?: NodeJS.ReadableStream | null } },
  onProgress?: (progress: { table: string; tablesSeen: number }) => void,
): void {
  if (!onProgress) return
  try {
    const stdout = running.child?.stdout
    if (!stdout) return

    let buffer = ''
    let tablesSeen = 0
    stdout.on('data', (chunk: Buffer | string) => {
      try {
        buffer += String(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const table = parseDbDiffProgress(line)
          if (table) {
            tablesSeen++
            onProgress({ table, tablesSeen })
          }
        }
      } catch {
        // Progress reporting is cosmetic — never let it break the run.
      }
    })
    stdout.on('error', () => {})
  } catch {
    // Same: cosmetic only.
  }
}

export async function runDbDiff(options: DbDiffOptions): Promise<DbDiffResult> {
  const { command, prefixArgs } = resolveDbDiffBin()
  const outputFile = join(tmpdir(), `supaforge-dbdiff-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)

  const args = [...prefixArgs, ...buildDbDiffArgs(options, outputFile)]

  const timeoutMs = resolveDbDiffTimeoutMs(options.timeoutSeconds)

  try {
    const running = execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: DBDIFF_MAX_BUFFER,
    })

    // Attach to the child's stdout for progress without changing how it is
    // executed — promisified execFile exposes the ChildProcess as `.child`,
    // so timeout, maxBuffer and every error path stay exactly as they were.
    attachProgress(running, options.onProgress)

    await running

    // When schemas are identical, dbdiff exits 0 but doesn't write the file
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (!fileExists) {
      return { up: '', down: '' }
    }

    const output = await readFile(outputFile, 'utf8')
    return parseDbDiffOutput(output)
  } catch (err: unknown) {
    const errObj = (err ?? {}) as Record<string, unknown>
    const message = errMsg(err)
    const stderr = String(errObj.stderr ?? '').trim()
    const stdout = String(errObj.stdout ?? '').trim()
    const combined = `${message} ${stderr}`
    if (
      combined.includes('ENOENT') ||
      combined.includes('not found') ||
      combined.includes('ERR_MODULE_NOT_FOUND') ||
      combined.includes('could not determine executable') ||
      combined.includes('404')
    ) {
      throw new DiagnosticError(
        '@dbdiff/cli is not installed. Install it with: npm install @dbdiff/cli',
      )
    }

    // @dbdiff/cli exits 1 when differences are found (standard diff convention).
    // The output file is written before exit — read it if it has real content.
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (fileExists) {
      const output = await readFile(outputFile, 'utf8')
      const parsed = parseDbDiffOutput(output)
      if (parsed.up || parsed.down) return parsed
    }

    // Timeout / killed process. execFileAsync sets `killed: true` and a SIGTERM
    // signal when it kills the child on timeout. Previously this fell through and
    // surfaced dbdiff's last progress line ("ℹ Now generating UP migration") as
    // the error — hiding the real cause. Report it clearly instead.
    const timedOut =
      errObj.killed === true ||
      errObj.signal === 'SIGTERM' ||
      errObj.code === 'ETIMEDOUT' ||
      /ETIMEDOUT|timed out/i.test(combined)
    if (timedOut) {
      const secs = Math.round(timeoutMs / 1000)
      throw new DiagnosticError(
        `Schema diff timed out after ${secs}s — the schema is very large or the ` +
        `database connection is slow.\n` +
        `  Remediations:\n` +
        `    • Raise the limit: set SUPAFORGE_DBDIFF_TIMEOUT=600 (seconds) and re-run.\n` +
        `    • Narrow the scan: diff one layer at a time with --check=schema.\n` +
        `    • Exclude large internal schemas via "ignoreSchemas" in supaforge.config.json.`,
      )
    }

    // No usable output file → genuine error (connection refused, auth, etc.).
    // Prefer stderr; otherwise fall back to stdout with dbdiff's progress/spinner
    // noise stripped so an info line never masquerades as the error. Strip the raw
    // "Command failed: /path/to/node ..." prefix which leaks connection URLs.
    const realError = stderr || stripDbDiffNoise(stdout)
    const cleanMessage = realError
      ? realError
      : message.replace(/^Command failed:[^\n]*/m, '').trim() || 'dbdiff failed with no error output'
    throw new Error(friendlyDbError(cleanMessage, options.sourceUrl))
  } finally {
    await unlink(outputFile).catch(() => {})
  }
}

const UP_MARKER = '-- ==================== UP ===================='
const DOWN_MARKER = '-- ==================== DOWN ===================='

const CREATE_FUNCTION = 'create-function'
const DROP_FUNCTION = 'drop-function'

const DROP_TYPES = ['drop', 'drop-view', DROP_FUNCTION, 'drop-trigger', 'drop-type', 'drop-sequence']

/**
 * Does this statement destroy data if executed?
 *
 * Deliberately narrower than DROP_TYPES: dropping a view, function, trigger or
 * type loses a definition that the migration can recreate, whereas dropping a
 * table or a column loses rows. Only the latter is gated at apply time, which
 * mirrors how @dbdiff/cli splits its own linter into errors and warnings.
 */
export function isDestructiveSql(sql: string): boolean {
  const upper = sql.toUpperCase().trimStart()
  if (upper.startsWith('DROP TABLE')) return true
  return upper.startsWith('ALTER TABLE') && /\bDROP\s+COLUMN\b/.test(upper)
}

export function parseDbDiffOutput(output: string): DbDiffResult {
  const upIdx = output.indexOf(UP_MARKER)
  const downIdx = output.indexOf(DOWN_MARKER)

  if (upIdx === -1 && downIdx === -1) {
    // Might be UP-only output without markers
    return { up: output.trim(), down: '' }
  }

  let up = ''
  let down = ''

  if (upIdx !== -1) {
    const upStart = upIdx + UP_MARKER.length
    const upEnd = downIdx !== -1 ? downIdx : output.length
    up = output.slice(upStart, upEnd).trim()
  }

  if (downIdx !== -1) {
    const downStart = downIdx + DOWN_MARKER.length
    down = output.slice(downStart).trim()
  }

  return { up, down }
}

/**
 * Convert @dbdiff/cli SQL output into DriftIssues.
 *
 * Each SQL statement (separated by `;`) becomes its own issue
 * with the appropriate severity and layer.
 *
 * When `ignoreSchemas` is provided, FK constraint statements that
 * reference tables in ignored schemas are filtered out — these are
 * false positives caused by dbdiff seeing stub tables.
 *
 * `ignoredSchemaTables` is an optional pre-queried set of table names
 * (lowercase) that exist inside ignored schemas. When provided it lets the
 * filter catch unqualified REFERENCES like `REFERENCES "users"` where
 * "users" lives in the ignored "auth" schema but dbdiff omitted the prefix.
 */
export function sqlToIssues(
  result: DbDiffResult,
  check: 'schema' | 'data',
  ignoreSchemas?: string[],
  ignoredSchemaTables?: Set<string>,
): DriftIssue[] {
  if (!result.up && !result.down) return []

  let upStatements = splitStatements(result.up)
  let downStatements = splitStatements(result.down)

  // Filter out FK constraints that reference tables in ignored schemas.
  // These arise because dbdiff compares stub tables vs real Supabase tables.
  // We check both UP and DOWN statements — dbdiff generates broken REFERENCES "" ("")
  // in the DOWN when the referenced table is in an ignored schema.
  // `ignoredSchemaTables` additionally catches unqualified refs like
  // REFERENCES "users" where "users" lives in the ignored "auth" schema.
  if (ignoreSchemas?.length && check === 'schema') {
    const keep = filterCrossSchemaFks(upStatements, downStatements, ignoreSchemas, ignoredSchemaTables)
    upStatements = upStatements.filter((_, i) => keep[i])
    downStatements = downStatements.filter((_, i) => keep[i])
  }

  if (upStatements.length === 0) return []

  const merged = mergeRoutineReplacements(upStatements, downStatements)

  // Generate one issue per UP statement, paired with its DOWN counterpart
  return merged.map(({ up: upSql, down: downSql, modifiedRoutine }, i) => {
    const type = classifyStatement(upSql)

    if (modifiedRoutine) {
      return {
        id: `${check}-alter-function-${i + 1}`,
        check,
        severity: 'warning' as const,
        title: `Function modified: ${modifiedRoutine}`,
        description: 'Function body differs between source and target.',
        sql: { up: upSql, down: downSql },
      }
    }

    return {
      id: `${check}-${type}-${i + 1}`,
      check,
      severity: DROP_TYPES.includes(type) ? 'critical' : 'warning',
      // The DOWN counterpart is passed so a title can recover a schema the UP
      // statement does not carry — see routineLabel (issue #47).
      title: summariseStatement(upSql, check, downSql),
      description: `${check === 'schema' ? 'Schema' : 'Data'} difference detected by @dbdiff/cli.`,
      sql: { up: upSql, down: downSql },
    }
  })
}

interface MergedStatement {
  up: string
  down: string
  /** Set when this entry is a DROP+CREATE pair replacing one routine. */
  modifiedRoutine?: string
}

/**
 * Collapse `DROP FUNCTION` + `CREATE [OR REPLACE] FUNCTION` pairs for the same
 * routine into a single entry.
 *
 * dbdiff replaces a changed function by emitting both statements. Treating them
 * as independent issues reported one modified function twice — once as a
 * CRITICAL "Extra function" and once as a WARNING "Function missing" — when it
 * is neither extra nor missing (issue #35). On a real diff that inflated 105
 * genuine differences into 149 reported issues, and dragged the drift score
 * down via the bogus criticals.
 *
 * Only a DROP followed by a CREATE for the same routine is merged; an
 * unpaired DROP is still a genuine "Extra function".
 *
 * Postgres allows overloading, so one name can own several DROP+CREATE pairs
 * whose argument types differ. They cannot be told apart by name, and the
 * statements do not agree on a signature to match them by (see `routineKey`),
 * so pairing goes by position:
 *
 * - Adjacent DROP+CREATE always merge. dbdiff renders a changed routine from a
 *   single diff object, so the two statements come out together — adjacency is
 *   what a replacement actually looks like.
 * - A non-adjacent pair merges only when that name has exactly one DROP and one
 *   CREATE in the batch, where there is nothing to confuse it with. This is
 *   the case issue #35 was about.
 *
 * Anything else stays unmerged and is reported as a genuine extra or missing
 * routine, which is the safe direction: over-reporting is noise, whereas a
 * wrong pairing writes a migration that drops an overload and recreates a
 * different one in its place.
 */
export function mergeRoutineReplacements(
  upStatements: string[],
  downStatements: string[],
): MergedStatement[] {
  // Per name, the indices of the CREATEs still up for grabs, in source order.
  const unclaimedCreates = new Map<string, number[]>()
  const dropCounts = new Map<string, number>()
  upStatements.forEach((sql, i) => {
    const type = classifyStatement(sql)
    const key = routineKey(sql)
    if (type === CREATE_FUNCTION) {
      unclaimedCreates.set(key, [...(unclaimedCreates.get(key) ?? []), i])
    } else if (type === DROP_FUNCTION) {
      dropCounts.set(key, (dropCounts.get(key) ?? 0) + 1)
    }
  })

  const absorbed = new Set<number>()
  const out: MergedStatement[] = []

  upStatements.forEach((upSql, i) => {
    if (absorbed.has(i)) return

    const down = downStatements[i] ?? ''
    if (classifyStatement(upSql) !== DROP_FUNCTION) {
      out.push({ up: upSql, down })
      return
    }

    const key = routineKey(upSql)
    const unambiguous = dropCounts.get(key) === 1 && unclaimedCreates.get(key)?.length === 1
    const createIdx = claimCreateFor(unclaimedCreates, key, i, unambiguous)
    if (createIdx === undefined) {
      out.push({ up: upSql, down })
      return
    }

    absorbed.add(createIdx)
    out.push({
      up: `${upSql}\n${upStatements[createIdx]}`,
      down: [down, downStatements[createIdx] ?? ''].filter(Boolean).join('\n'),
      modifiedRoutine: extractRoutineName(upStatements[createIdx]) + extractRoutineArgs(upSql),
    })
  })

  return out
}

/**
 * Claim the CREATE that replaces the DROP at `dropIdx`, removing it so a later
 * DROP of the same name cannot claim it too.
 *
 * Normally that is the immediately following statement. When `unambiguous` —
 * one DROP and one CREATE for this name in the whole batch — any later CREATE
 * will do, since there is no second candidate to get it wrong.
 */
function claimCreateFor(
  unclaimed: Map<string, number[]>,
  key: string,
  dropIdx: number,
  unambiguous: boolean,
): number | undefined {
  const queue = unclaimed.get(key)
  if (!queue) return undefined

  const at = queue.findIndex((idx) => (unambiguous ? idx > dropIdx : idx === dropIdx + 1))
  if (at === -1) return undefined

  return queue.splice(at, 1)[0]
}

/**
 * Identify which UP statements to keep after filtering cross-schema FK false positives.
 *
 * Two-pass approach:
 * 1. Mark ADD CONSTRAINT ... FOREIGN KEY statements where the UP references an
 *    ignored schema or the DOWN counterpart has broken `REFERENCES "" ("")`,
 *    or the referenced table (even unqualified) is in `ignoredSchemaTables`.
 * 2. Mark paired DROP CONSTRAINT statements that share the same constraint name.
 */
function filterCrossSchemaFks(
  upStmts: string[],
  downStmts: string[],
  schemas: string[],
  ignoredSchemaTables?: Set<string>,
): boolean[] {
  const keep = new Array<boolean>(upStmts.length).fill(true)

  // Collect constraint names that are cross-schema FKs
  const crossSchemaConstraints = new Set<string>()

  // Pass 1: detect ADD CONSTRAINT ... FOREIGN KEY with cross-schema refs
  for (let i = 0; i < upStmts.length; i++) {
    const upper = upStmts[i].toUpperCase()
    if (!upper.includes('ADD CONSTRAINT') || !upper.includes('FOREIGN KEY')) continue

    const isCrossSchema =
      hasCrossSchemaRef(upStmts[i], schemas, ignoredSchemaTables) ||
      (downStmts[i] != null && hasBrokenRef(downStmts[i]))

    if (isCrossSchema) {
      keep[i] = false
      const name = upStmts[i].match(/CONSTRAINT\s+"([^"]+)"/i)?.[1]
      if (name) crossSchemaConstraints.add(name)
    }
  }

  // Pass 2: filter paired DROP CONSTRAINT for the same FK names
  for (let i = 0; i < upStmts.length; i++) {
    if (!keep[i]) continue
    const upper = upStmts[i].toUpperCase()
    if (!upper.includes('DROP CONSTRAINT')) continue
    const name = upStmts[i].match(/DROP\s+CONSTRAINT\s+"([^"]+)"/i)?.[1]
    if (name && crossSchemaConstraints.has(name)) {
      keep[i] = false
    }
  }

  return keep
}

/**
 * Check if a REFERENCES clause points to an ignored schema, is empty/broken,
 * or is unqualified but the referenced table exists in an ignored schema.
 *
 * Handles three forms:
 *   REFERENCES "" ("")              — broken ref from dbdiff, always filtered
 *   REFERENCES "auth"."users" ("id") — schema-qualified, filtered if schema ignored
 *   REFERENCES "users" ("id")        — unqualified, filtered if "users" is in
 *                                       ignoredSchemaTables (queried from target DB)
 */
function hasCrossSchemaRef(sql: string, schemas: string[], ignoredSchemaTables?: Set<string>): boolean {
  const refsMatch = sql.match(/REFERENCES\s+"([^"]*)"(?:\s*\.\s*"([^"]*)")?\s*\(\s*"([^"]*)"\s*\)/i)
  if (!refsMatch) return false
  const [, first, second] = refsMatch
  // Broken: REFERENCES "" ("")
  if (first === '') return true
  // Schema-qualified: REFERENCES "auth"."users" ("id")
  if (second !== undefined) {
    return schemas.some(s => s.toLowerCase() === first.toLowerCase())
  }
  // Unqualified: REFERENCES "users" ("id") — filter if the table lives in an ignored schema.
  // This catches the case where pg_dump or dbdiff drops the schema prefix due to
  // search_path, so the reference appears unqualified even though it targets e.g. auth.users.
  return ignoredSchemaTables ? ignoredSchemaTables.has(first.toLowerCase()) : false
}

/** Check if SQL contains a broken REFERENCES "" ("") from dbdiff. */
function hasBrokenRef(sql: string): boolean {
  return /REFERENCES\s+""\s*\(\s*""\s*\)/i.test(sql)
}

function splitStatements(sql: string): string[] {
  if (!sql) return []

  const statements: string[] = []
  let buf = ''
  let i = 0

  while (i < sql.length) {
    // Dollar-quoted string: $tag$...$tag$ consumed as a single token so that
    // semicolons inside function/trigger/procedure bodies are not treated as
    // statement boundaries. The tag is /\$([A-Za-z0-9_]*)\$/ e.g. $$ or $body$.
    if (sql[i] === '$') {
      const tagMatch = sql.slice(i + 1).match(/^([A-Za-z0-9_]*)\$/)
      if (tagMatch) {
        const tag = `$${tagMatch[1]}$`
        const closeIdx = sql.indexOf(tag, i + tag.length)
        if (closeIdx !== -1) {
          buf += sql.slice(i, closeIdx + tag.length)
          i = closeIdx + tag.length
          continue
        }
      }
    }

    // Statement boundary: ';' optionally followed by spaces/tabs/CR then '\n'
    if (sql[i] === ';') {
      buf += ';'
      i++
      let j = i
      while (j < sql.length && (sql[j] === ' ' || sql[j] === '\t' || sql[j] === '\r')) j++
      if (j >= sql.length || sql[j] === '\n') {
        const stmt = buf.trim()
        if (stmt.length > 0 && !stmt.startsWith('--')) {
          statements.push(stmt)
        }
        buf = ''
        i = j < sql.length ? j + 1 : j
      }
      continue
    }

    buf += sql[i]
    i++
  }

  // Flush any trailing content without a statement-ending newline
  const last = buf.trim()
  if (last.length > 0 && !last.startsWith('--')) {
    statements.push(last.endsWith(';') ? last : `${last};`)
  }

  return statements
}

export function classifyStatement(sql: string): string {
  const upper = sql.toUpperCase().trimStart()
  // Views
  if (upper.startsWith('CREATE VIEW') || upper.startsWith('CREATE OR REPLACE VIEW')) return 'create-view'
  if (upper.startsWith('ALTER VIEW')) return 'alter-view'
  if (upper.startsWith('DROP VIEW')) return 'drop-view'
  // Functions / procedures
  if (upper.startsWith('CREATE FUNCTION') || upper.startsWith('CREATE OR REPLACE FUNCTION')) return CREATE_FUNCTION
  if (upper.startsWith('ALTER FUNCTION')) return 'alter-function'
  if (upper.startsWith('DROP FUNCTION')) return DROP_FUNCTION
  if (upper.startsWith('CREATE PROCEDURE') || upper.startsWith('CREATE OR REPLACE PROCEDURE')) return CREATE_FUNCTION
  if (upper.startsWith('DROP PROCEDURE')) return DROP_FUNCTION
  // Triggers
  if (upper.startsWith('CREATE TRIGGER') || upper.startsWith('CREATE OR REPLACE TRIGGER')) return 'create-trigger'
  if (upper.startsWith('ALTER TRIGGER')) return 'alter-trigger'
  if (upper.startsWith('DROP TRIGGER')) return 'drop-trigger'
  // Types / enums / domains
  if (upper.startsWith('CREATE TYPE')) return 'create-type'
  if (upper.startsWith('ALTER TYPE')) return 'alter-type'
  if (upper.startsWith('DROP TYPE')) return 'drop-type'
  if (upper.startsWith('CREATE DOMAIN')) return 'create-type'
  if (upper.startsWith('ALTER DOMAIN')) return 'alter-type'
  if (upper.startsWith('DROP DOMAIN')) return 'drop-type'
  // Tables
  if (upper.startsWith('ALTER TABLE')) return 'alter'
  if (upper.startsWith('CREATE TABLE')) return 'create-table'
  if (upper.startsWith('DROP TABLE')) return 'drop'
  // Indexes
  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) return 'create-index'
  if (upper.startsWith('DROP INDEX')) return 'drop'
  // Sequences
  if (upper.startsWith('CREATE SEQUENCE')) return 'create-sequence'
  if (upper.startsWith('ALTER SEQUENCE')) return 'alter-sequence'
  if (upper.startsWith('DROP SEQUENCE')) return 'drop-sequence'
  // Data
  if (upper.startsWith('INSERT')) return 'insert'
  if (upper.startsWith('UPDATE')) return 'update'
  if (upper.startsWith('DELETE')) return 'delete'
  return 'change'
}

/**
 * One title format for every schema finding: `<Finding>: <schema>.<name>`.
 *
 * Each kind used to carry its own ad-hoc regex, and two of them read the wrong
 * capture group: `/INDEX\s+.../` never reached the index name at all, so
 * `CREATE INDEX idx_orders_status ON public.orders` was titled "Index missing on
 * public" — the schema, in the name's place (issue #47). The rules below all
 * go through one schema-aware identifier parser instead.
 *
 * Matched in order and anchored at the start of the statement, so a trigger
 * that executes a function is a trigger, not a function.
 */
interface SummaryRule {
  match: RegExp
  label: string
  name: (sql: string, downSql?: string) => string
}

/** Head patterns for the identifier that follows each keyword. */
const AFTER = {
  view: /\bVIEW\s+(?:IF\s+EXISTS\s+)?/i,
  trigger: /\bTRIGGER\s+(?:IF\s+EXISTS\s+)?/i,
  type: /\bTYPE\s+(?:IF\s+EXISTS\s+)?/i,
  domain: /\bDOMAIN\s+(?:IF\s+EXISTS\s+)?/i,
  sequence: /\bSEQUENCE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  table: /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?/i,
  index: /\bINDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  on: /\bON\s+(?:ONLY\s+)?/i,
}

/** Name an object by the identifier following `head`. */
const named = (head: RegExp) => (sql: string) => extractQualifiedName(sql, head)

/**
 * Qualify an index with the schema of the table it is on.
 *
 * Postgres puts an index in its table's schema and its grammar does not let
 * the CREATE qualify the index name, so the `ON` clause is where the schema
 * actually is. Left bare when the table is unqualified too — the schema is
 * then genuinely unknown, and inventing `public` would be a guess.
 */
function indexLabel(sql: string): string {
  const name = extractQualifiedName(sql, AFTER.index)
  if (name === UNKNOWN_NAME || name.includes('.')) return name

  const table = extractQualifiedName(sql, AFTER.on)
  const dot = table.lastIndexOf('.')
  return dot === -1 ? name : `${table.slice(0, dot)}.${name}`
}

const SCHEMA_RULES: SummaryRule[] = [
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i, label: 'View missing', name: named(AFTER.view) },
  { match: /^\s*ALTER\s+(?:MATERIALIZED\s+)?VIEW\b/i, label: 'View altered', name: named(AFTER.view) },
  { match: /^\s*DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i, label: 'Extra view', name: named(AFTER.view) },

  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i, label: 'Function missing', name: routineLabel },
  { match: /^\s*ALTER\s+FUNCTION\b/i, label: 'Function altered', name: routineLabel },
  { match: /^\s*DROP\s+FUNCTION\b/i, label: 'Extra function', name: routineLabel },
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i, label: 'Procedure missing', name: routineLabel },
  { match: /^\s*DROP\s+PROCEDURE\b/i, label: 'Extra procedure', name: routineLabel },

  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, label: 'Trigger missing', name: named(AFTER.trigger) },
  { match: /^\s*ALTER\s+TRIGGER\b/i, label: 'Trigger altered', name: named(AFTER.trigger) },
  { match: /^\s*DROP\s+TRIGGER\b/i, label: 'Extra trigger', name: named(AFTER.trigger) },

  { match: /^\s*CREATE\s+TYPE\b/i, label: 'Type missing', name: named(AFTER.type) },
  { match: /^\s*ALTER\s+TYPE\b/i, label: 'Type altered', name: named(AFTER.type) },
  { match: /^\s*DROP\s+TYPE\b/i, label: 'Extra type', name: named(AFTER.type) },
  { match: /^\s*CREATE\s+DOMAIN\b/i, label: 'Domain missing', name: named(AFTER.domain) },
  { match: /^\s*ALTER\s+DOMAIN\b/i, label: 'Domain altered', name: named(AFTER.domain) },
  { match: /^\s*DROP\s+DOMAIN\b/i, label: 'Extra domain', name: named(AFTER.domain) },

  { match: /^\s*ALTER\s+TABLE\b/i, label: 'Table altered', name: named(AFTER.table) },
  { match: /^\s*CREATE\s+TABLE\b/i, label: 'Table missing', name: named(AFTER.table) },
  { match: /^\s*DROP\s+TABLE\b/i, label: 'Extra table', name: named(AFTER.table) },

  { match: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i, label: 'Index missing', name: indexLabel },
  { match: /^\s*DROP\s+INDEX\b/i, label: 'Extra index', name: named(AFTER.index) },

  { match: /^\s*CREATE\s+SEQUENCE\b/i, label: 'Sequence missing', name: named(AFTER.sequence) },
  { match: /^\s*ALTER\s+SEQUENCE\b/i, label: 'Sequence altered', name: named(AFTER.sequence) },
  { match: /^\s*DROP\s+SEQUENCE\b/i, label: 'Extra sequence', name: named(AFTER.sequence) },
]

/** Titles for the row-level findings of the data check. */
function summariseDataStatement(sql: string): string {
  const table = extractQualifiedName(sql, /\b(?:INTO|FROM|UPDATE)\s+(?:ONLY\s+)?/i)
  const upper = sql.toUpperCase().trimStart()
  if (upper.startsWith('INSERT')) return `Missing row in ${table}`
  if (upper.startsWith('DELETE')) return `Extra row in ${table}`
  if (upper.startsWith('UPDATE')) return `Modified row in ${table}`
  return `Data change in ${table}`
}

/**
 * Title one finding.
 *
 * `downSql` is the paired counterpart statement, used only to recover a schema
 * the UP statement does not carry — see `routineLabel`.
 */
export function summariseStatement(sql: string, check: 'schema' | 'data', downSql?: string): string {
  if (check === 'data') return summariseDataStatement(sql)

  for (const rule of SCHEMA_RULES) {
    if (rule.match.test(sql)) return `${rule.label}: ${rule.name(sql, downSql)}`
  }

  return `Schema change in ${extractQualifiedName(sql, /\b(?:TABLE|INTO|FROM|UPDATE)\s+(?:ONLY\s+)?/i)}`
}

/**
 * Name a routine in an issue title, schema-qualified, with its argument
 * signature.
 *
 * The detection has been signature-aware since overloads were fixed, but only
 * the "Function modified" title carried the signature through — "Extra
 * function" printed the bare name (issue #40). For an overloaded routine that
 * left the title unable to say which overload was being dropped, and two
 * target-only overloads of one name produced two identical titles.
 *
 * The schema is still never invented, but it no longer has to be missing.
 * dbdiff emits a DROP unqualified (`DROP FUNCTION IF EXISTS "example_fn"(uuid)`)
 * while the DOWN statement that restores the same routine comes from
 * `pg_get_functiondef` and *is* qualified. So when the UP has no schema, it is
 * read off that counterpart — a schema dbdiff itself reported, not a guess —
 * which is what left "Extra function" the one unqualified schema title
 * (issue #47).
 *
 * The counterpart is only trusted when it names the same routine; a mismatched
 * pair would otherwise attach one routine's schema to another's name.
 */
export function routineLabel(sql: string, downSql?: string): string {
  const name = extractRoutineName(sql)
  const args = extractRoutineArgs(sql)
  if (!downSql || name === UNKNOWN_NAME || name.includes('.')) return name + args

  const counterpart = extractRoutineName(downSql)
  const sameRoutine = unqualify(counterpart) === unqualify(name)
  return (counterpart.includes('.') && sameRoutine ? counterpart : name) + args
}

/** The last segment of a possibly schema-qualified name, lowercased. */
function unqualify(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

/**
 * Extract a routine name from a FUNCTION or PROCEDURE statement.
 *
 * A bare `/FUNCTION\s+"?(\w+)"?/` gets this wrong in both directions
 * (issue #35): it returns "IF" for `DROP FUNCTION IF EXISTS "f"`, and the
 * schema qualifier "public" for `CREATE OR REPLACE FUNCTION public.f(...)`.
 * Neither title named the routine at all.
 *
 * Skips an optional IF EXISTS, then takes the optionally schema-qualified,
 * optionally quoted identifier, normalising `"public" . "f"` to `public.f`.
 */
export function extractRoutineName(sql: string): string {
  return extractQualifiedName(sql, /\b(?:FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS\s+)?/i)
}

/** What a title shows when the identifier cannot be read out of the SQL. */
export const UNKNOWN_NAME = 'unknown'

/**
 * Read the optionally schema-qualified, optionally quoted identifier that
 * follows `head`, normalising `"public" . "f"` to `public.f`.
 *
 * The one identifier parser behind every schema title. Before it, each kind
 * carried its own `/KEYWORD\s+["'`]?(\w+)/`, and those got it wrong in both
 * directions (issues #35, #47): "IF" for `DROP FUNCTION IF EXISTS "f"`, and the
 * schema qualifier "public" for anything written `public.name` — which is how
 * an index came to be titled by its schema instead of its name.
 *
 * Matched piecewise rather than as one expression. A combined pattern needs an
 * optional quote on both sides of each identifier ("?[\w$]+"?), and that
 * ambiguity backtracks super-linearly on adversarial input — a real concern for
 * SQL arriving from an external process.
 */
export function extractQualifiedName(sql: string, head: RegExp): string {
  const found = head.exec(sql)
  if (!found) return UNKNOWN_NAME

  let rest = sql.slice(found.index + found[0].length)
  const parts: string[] = []

  for (let depth = 0; depth < 2; depth++) {
    const ident = /^(?:"([^"]*)"|([\w$]+))/.exec(rest)
    if (!ident) break
    parts.push(ident[1] ?? ident[2])
    rest = rest.slice(ident[0].length)

    const dot = /^\s*\.\s*/.exec(rest)
    if (!dot) break
    rest = rest.slice(dot[0].length)
  }

  return parts.length > 0 ? parts.join('.') : UNKNOWN_NAME
}

/**
 * Extract the argument list of a `DROP FUNCTION`, parens included.
 *
 * @dbdiff/cli >= 3.0.0-rc.7 qualifies the DROP with the argument types so an
 * overloaded routine can be dropped unambiguously — `DROP FUNCTION IF EXISTS
 * "dist"(bigint,bigint)`. Earlier versions emitted a bare name, and MySQL has
 * no overloading, so both return ''.
 *
 * Scanned rather than matched. The types can themselves contain parens
 * (`numeric(10,2)`), so this counts depth instead of taking the first `)`.
 */
export function extractRoutineArgs(sql: string): string {
  const open = sql.indexOf('(')
  if (open === -1) return ''

  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')' && --depth === 0) return sql.slice(open, i + 1)
  }
  return ''
}

/**
 * Key a routine for pairing a DROP with the CREATE that replaces it.
 *
 * The unqualified, lowercased name — dbdiff emits the DROP unqualified (`DROP
 * FUNCTION IF EXISTS "f"`) and the CREATE qualified (`CREATE OR REPLACE
 * FUNCTION public.f(...)`), so the schema has to come off before they match.
 *
 * Deliberately excludes the argument types even though the DROP now carries
 * them, because the CREATE does not: it comes from `pg_get_functiondef`, which
 * renders parameter names and defaults (`f(a text, b text DEFAULT 'x')`) rather
 * than the bare type list `regprocedure` gives the DROP. Overloads therefore
 * share a key, and `mergeRoutineReplacements` separates them by position.
 */
function routineKey(sql: string): string {
  const name = extractRoutineName(sql)
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}
