import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, unlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DriftIssue } from './types/drift'

const execFileAsync = promisify(execFile)

export interface DbDiffOptions {
  sourceUrl: string
  targetUrl: string
  type: 'schema' | 'data' | 'all'
  include: 'up' | 'down' | 'both'
  tables?: string[]
  ignoreTables?: string[]
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

  try {
    await execFileAsync(command, args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    })

    // When schemas are identical, dbdiff exits 0 but doesn't write the file
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (!fileExists) {
      return { up: '', down: '' }
    }

    const output = await readFile(outputFile, 'utf8')
    return parseDbDiffOutput(output)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const stderr = String((err as Record<string, unknown>)?.stderr ?? '')
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
    throw err
  } finally {
    await unlink(outputFile).catch(() => {})
  }
}

const UP_MARKER = '-- ==================== UP ===================='
const DOWN_MARKER = '-- ==================== DOWN ===================='

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
 */
export function sqlToIssues(
  result: DbDiffResult,
  layer: 'schema' | 'data',
): DriftIssue[] {
  if (!result.up && !result.down) return []

  const upStatements = splitStatements(result.up)
  const downStatements = splitStatements(result.down)

  if (upStatements.length === 0) return []

  // Generate one issue per UP statement, paired with its DOWN counterpart
  return upStatements.map((upSql, i) => {
    const downSql = downStatements[i] ?? ''
    const type = classifyStatement(upSql)

    return {
      id: `${layer}-${type}-${i + 1}`,
      layer,
      severity: type === 'drop' ? 'critical' : 'warning',
      title: summariseStatement(upSql, layer),
      description: `${layer === 'schema' ? 'Schema' : 'Data'} difference detected by @dbdiff/cli.`,
      sql: { up: upSql, down: downSql },
    }
  })
}

function splitStatements(sql: string): string[] {
  if (!sql) return []
  return sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))
    .map(s => (s.endsWith(';') ? s : `${s};`))
}

function classifyStatement(sql: string): string {
  const upper = sql.toUpperCase().trimStart()
  if (upper.startsWith('ALTER TABLE')) return 'alter'
  if (upper.startsWith('CREATE TABLE')) return 'create-table'
  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) return 'create-index'
  if (upper.startsWith('DROP TABLE')) return 'drop'
  if (upper.startsWith('DROP INDEX')) return 'drop'
  if (upper.startsWith('INSERT')) return 'insert'
  if (upper.startsWith('UPDATE')) return 'update'
  if (upper.startsWith('DELETE')) return 'delete'
  return 'change'
}

function summariseStatement(sql: string, layer: 'schema' | 'data'): string {
  const upper = sql.toUpperCase().trimStart()
  // Extract table name from common patterns
  const tableMatch = sql.match(/(?:TABLE|INTO|FROM|UPDATE)\s+["'`]?(\w+)["'`]?/i)
  const table = tableMatch?.[1] ?? 'unknown'

  if (layer === 'data') {
    if (upper.startsWith('INSERT')) return `Missing row in ${table}`
    if (upper.startsWith('DELETE')) return `Extra row in ${table}`
    if (upper.startsWith('UPDATE')) return `Modified row in ${table}`
    return `Data change in ${table}`
  }

  if (upper.startsWith('ALTER TABLE')) return `Table altered: ${table}`
  if (upper.startsWith('CREATE TABLE')) return `Table missing: ${table}`
  if (upper.startsWith('DROP TABLE')) return `Extra table: ${table}`
  if (upper.startsWith('CREATE INDEX')) return `Index missing on ${table}`
  if (upper.startsWith('DROP INDEX')) return `Extra index`
  return `Schema change in ${table}`
}
