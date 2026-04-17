import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, unlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DriftIssue } from './types/drift'
import { errMsg, friendlyDbError } from './utils/error'
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
export async function runDbDiff(options: DbDiffOptions): Promise<DbDiffResult> {
  const { command, prefixArgs } = resolveDbDiffBin()
  const outputFile = join(tmpdir(), `supaforge-dbdiff-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)

  const args = [
    ...prefixArgs,
    'diff',
    `--server1-url=${options.sourceUrl}`,
    `--server2-url=${options.targetUrl}`,
    `--type=${options.type}`,
    '--include=both',
    '--nocomments',
    `--output=${outputFile}`,
  ]

  if (options.tables?.length) {
    args.push(`--tables=${options.tables.join(',')}`)
  }

  if (options.ignoreTables?.length) {
    args.push(`--ignore-tables=${options.ignoreTables.join(',')}`)
  }

  // Convert ignoreSchemas to --ignore-tables glob patterns (e.g. auth.* , storage.*)
  if (options.ignoreSchemas?.length) {
    const schemaGlobs = options.ignoreSchemas.map(s => `${s}.*`)
    const existing = args.find(a => a.startsWith('--ignore-tables='))
    if (existing) {
      const idx = args.indexOf(existing)
      args[idx] = `${existing},${schemaGlobs.join(',')}`
    } else {
      args.push(`--ignore-tables=${schemaGlobs.join(',')}`)
    }
  }

  try {
    await execFileAsync(command, args, {
      timeout: DBDIFF_EXEC_TIMEOUT_MS,
      maxBuffer: DBDIFF_MAX_BUFFER,
    })

    // When schemas are identical, dbdiff exits 0 but doesn't write the file
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (!fileExists) {
      return { up: '', down: '' }
    }

    const output = await readFile(outputFile, 'utf8')
    return parseDbDiffOutput(output)
  } catch (err: unknown) {
    const message = errMsg(err)
    const stderr = String((err as Record<string, unknown>)?.stderr ?? '').trim()
    const combined = `${message} ${stderr}`
    if (
      combined.includes('ENOENT') ||
      combined.includes('not found') ||
      combined.includes('ERR_MODULE_NOT_FOUND') ||
      combined.includes('could not determine executable') ||
      combined.includes('404')
    ) {
      throw new Error(
        '@dbdiff/cli is not installed. Install it with: npm install @dbdiff/cli',
      )
    }
    // Use stderr (actual DB error) when available; fall through friendlyDbError
    // to translate raw pg errors into actionable messages and strip the raw
    // "Command failed: ..." exec wrapper that leaks connection URLs.
    const dbErr = stderr || message
    throw new Error(friendlyDbError(dbErr, options.sourceUrl))
  } finally {
    await unlink(outputFile).catch(() => {})
  }
}

const UP_MARKER = '-- ==================== UP ===================='
const DOWN_MARKER = '-- ==================== DOWN ===================='

const DROP_TYPES = ['drop', 'drop-view', 'drop-function', 'drop-trigger', 'drop-type', 'drop-sequence']

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
 */
export function sqlToIssues(
  result: DbDiffResult,
  check: 'schema' | 'data',
  ignoreSchemas?: string[],
): DriftIssue[] {
  if (!result.up && !result.down) return []

  let upStatements = splitStatements(result.up)
  let downStatements = splitStatements(result.down)

  // Filter out FK constraints that reference tables in ignored schemas.
  // These arise because dbdiff compares stub tables vs real Supabase tables.
  // We check both UP and DOWN statements — dbdiff generates broken REFERENCES "" ("")
  // in the DOWN when the referenced table is in an ignored schema.
  if (ignoreSchemas?.length && check === 'schema') {
    const keep = filterCrossSchemaFks(upStatements, downStatements, ignoreSchemas)
    upStatements = upStatements.filter((_, i) => keep[i])
    downStatements = downStatements.filter((_, i) => keep[i])
  }

  if (upStatements.length === 0) return []

  // Generate one issue per UP statement, paired with its DOWN counterpart
  return upStatements.map((upSql, i) => {
    const downSql = downStatements[i] ?? ''
    const type = classifyStatement(upSql)

    return {
      id: `${check}-${type}-${i + 1}`,
      check,
      severity: DROP_TYPES.includes(type) ? 'critical' : 'warning',
      title: summariseStatement(upSql, check),
      description: `${check === 'schema' ? 'Schema' : 'Data'} difference detected by @dbdiff/cli.`,
      sql: { up: upSql, down: downSql },
    }
  })
}

/**
 * Identify which UP statements to keep after filtering cross-schema FK false positives.
 *
 * Two-pass approach:
 * 1. Mark ADD CONSTRAINT ... FOREIGN KEY statements where the UP references an
 *    ignored schema or the DOWN counterpart has broken `REFERENCES "" ("")`.
 * 2. Mark paired DROP CONSTRAINT statements that share the same constraint name.
 */
function filterCrossSchemaFks(
  upStmts: string[],
  downStmts: string[],
  schemas: string[],
): boolean[] {
  const keep = new Array<boolean>(upStmts.length).fill(true)

  // Collect constraint names that are cross-schema FKs
  const crossSchemaConstraints = new Set<string>()

  // Pass 1: detect ADD CONSTRAINT ... FOREIGN KEY with cross-schema refs
  for (let i = 0; i < upStmts.length; i++) {
    const upper = upStmts[i].toUpperCase()
    if (!upper.includes('ADD CONSTRAINT') || !upper.includes('FOREIGN KEY')) continue

    const isCrossSchema =
      hasCrossSchemaRef(upStmts[i], schemas) ||
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

/** Check if a REFERENCES clause points to an ignored schema or is empty. */
function hasCrossSchemaRef(sql: string, schemas: string[]): boolean {
  const refsMatch = sql.match(/REFERENCES\s+"([^"]*)"(?:\s*\.\s*"([^"]*)")?\s*\(\s*"([^"]*)"\s*\)/i)
  if (!refsMatch) return false
  const [, first, second] = refsMatch
  // Broken: REFERENCES "" ("")
  if (first === '') return true
  // Schema-qualified: REFERENCES "auth"."users" ("id")
  if (second !== undefined) {
    return schemas.some(s => s.toLowerCase() === first.toLowerCase())
  }
  return false
}

/** Check if SQL contains a broken REFERENCES "" ("") from dbdiff. */
function hasBrokenRef(sql: string): boolean {
  return /REFERENCES\s+""\s*\(\s*""\s*\)/i.test(sql)
}

function splitStatements(sql: string): string[] {
  if (!sql) return []
  return sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))
    .map(s => (s.endsWith(';') ? s : `${s};`))
}

export function classifyStatement(sql: string): string {
  const upper = sql.toUpperCase().trimStart()
  // Views
  if (upper.startsWith('CREATE VIEW') || upper.startsWith('CREATE OR REPLACE VIEW')) return 'create-view'
  if (upper.startsWith('ALTER VIEW')) return 'alter-view'
  if (upper.startsWith('DROP VIEW')) return 'drop-view'
  // Functions / procedures
  if (upper.startsWith('CREATE FUNCTION') || upper.startsWith('CREATE OR REPLACE FUNCTION')) return 'create-function'
  if (upper.startsWith('ALTER FUNCTION')) return 'alter-function'
  if (upper.startsWith('DROP FUNCTION')) return 'drop-function'
  if (upper.startsWith('CREATE PROCEDURE') || upper.startsWith('CREATE OR REPLACE PROCEDURE')) return 'create-function'
  if (upper.startsWith('DROP PROCEDURE')) return 'drop-function'
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

export function summariseStatement(sql: string, check: 'schema' | 'data'): string {
  const upper = sql.toUpperCase().trimStart()

  if (check === 'data') {
    const table = extractName(sql, /(?:INTO|FROM|UPDATE)\s+["'`]?(\w+)["'`]?/i)
    if (upper.startsWith('INSERT')) return `Missing row in ${table}`
    if (upper.startsWith('DELETE')) return `Extra row in ${table}`
    if (upper.startsWith('UPDATE')) return `Modified row in ${table}`
    return `Data change in ${table}`
  }

  // Views
  if (upper.startsWith('CREATE VIEW') || upper.startsWith('CREATE OR REPLACE VIEW')) {
    return `View missing: ${extractName(sql, /VIEW\s+["'`]?(\w+)["'`]?/i)}`
  }
  if (upper.startsWith('ALTER VIEW')) return `View altered: ${extractName(sql, /VIEW\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP VIEW')) return `Extra view: ${extractName(sql, /VIEW\s+["'`]?(\w+)["'`]?/i)}`

  // Functions / procedures
  if (upper.startsWith('CREATE FUNCTION') || upper.startsWith('CREATE OR REPLACE FUNCTION')) {
    return `Function missing: ${extractName(sql, /FUNCTION\s+["'`]?(\w+)["'`]?/i)}`
  }
  if (upper.startsWith('ALTER FUNCTION')) return `Function altered: ${extractName(sql, /FUNCTION\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP FUNCTION')) return `Extra function: ${extractName(sql, /FUNCTION\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('CREATE PROCEDURE') || upper.startsWith('CREATE OR REPLACE PROCEDURE')) {
    return `Procedure missing: ${extractName(sql, /PROCEDURE\s+["'`]?(\w+)["'`]?/i)}`
  }
  if (upper.startsWith('DROP PROCEDURE')) return `Extra procedure: ${extractName(sql, /PROCEDURE\s+["'`]?(\w+)["'`]?/i)}`

  // Triggers
  if (upper.startsWith('CREATE TRIGGER') || upper.startsWith('CREATE OR REPLACE TRIGGER')) {
    return `Trigger missing: ${extractName(sql, /TRIGGER\s+["'`]?(\w+)["'`]?/i)}`
  }
  if (upper.startsWith('ALTER TRIGGER')) return `Trigger altered: ${extractName(sql, /TRIGGER\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP TRIGGER')) return `Extra trigger: ${extractName(sql, /TRIGGER\s+["'`]?(\w+)["'`]?/i)}`

  // Types / enums / domains
  if (upper.startsWith('CREATE TYPE')) return `Type missing: ${extractName(sql, /TYPE\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('ALTER TYPE')) return `Type altered: ${extractName(sql, /TYPE\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP TYPE')) return `Extra type: ${extractName(sql, /TYPE\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('CREATE DOMAIN')) return `Domain missing: ${extractName(sql, /DOMAIN\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('ALTER DOMAIN')) return `Domain altered: ${extractName(sql, /DOMAIN\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP DOMAIN')) return `Extra domain: ${extractName(sql, /DOMAIN\s+["'`]?(\w+)["'`]?/i)}`

  // Tables
  const table = extractName(sql, /TABLE\s+["'`]?(\w+)["'`]?/i)
  if (upper.startsWith('ALTER TABLE')) return `Table altered: ${table}`
  if (upper.startsWith('CREATE TABLE')) return `Table missing: ${table}`
  if (upper.startsWith('DROP TABLE')) return `Extra table: ${table}`

  // Indexes
  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
    return `Index missing on ${extractName(sql, /ON\s+["'`]?(\w+)["'`]?/i)}`
  }
  if (upper.startsWith('DROP INDEX')) return `Extra index: ${extractName(sql, /INDEX\s+["'`]?(\w+)["'`]?/i)}`

  // Sequences
  if (upper.startsWith('CREATE SEQUENCE')) return `Sequence missing: ${extractName(sql, /SEQUENCE\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('ALTER SEQUENCE')) return `Sequence altered: ${extractName(sql, /SEQUENCE\s+["'`]?(\w+)["'`]?/i)}`
  if (upper.startsWith('DROP SEQUENCE')) return `Extra sequence: ${extractName(sql, /SEQUENCE\s+["'`]?(\w+)["'`]?/i)}`

  return `Schema change in ${extractName(sql, /(?:TABLE|INTO|FROM|UPDATE)\s+["'`]?(\w+)["'`]?/i)}`
}

function extractName(sql: string, pattern: RegExp): string {
  return sql.match(pattern)?.[1] ?? 'unknown'
}
