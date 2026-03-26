import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DriftIssue } from './types/drift'

const execFileAsync = promisify(execFile)

export interface DbDiffOptions {
  sourceUrl: string
  targetUrl: string
  type: 'schema' | 'data' | 'all'
  include: 'up' | 'down' | 'both'
  ignoreSchemas?: string[]
  tables?: string[]
}

export interface DbDiffResult {
  up: string
  down: string
}

/**
 * Run @dbdiff/cli and parse UP/DOWN SQL output.
 *
 * Returns { up, down } SQL strings extracted from the
 * `#---------- UP ----------` / `#---------- DOWN ----------` markers.
 *
 * When @dbdiff/cli is not installed, throws with a clear message.
 */
export async function runDbDiff(options: DbDiffOptions): Promise<DbDiffResult> {
  const args = [
    '@dbdiff/cli',
    'diff',
    '--supabase',
    `--server1-url=${options.sourceUrl}`,
    `--server2-url=${options.targetUrl}`,
    `--type=${options.type}`,
    '--include=both',
    '--nocomments',
  ]

  if (options.ignoreSchemas?.length) {
    args.push(`--ignore-schema=${options.ignoreSchemas.join(',')}`)
  }

  if (options.tables?.length) {
    args.push(`--tables=${options.tables.join(',')}`)
  }

  try {
    const { stdout } = await execFileAsync('npx', args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return parseDbDiffOutput(stdout)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ENOENT') || message.includes('not found') || message.includes('ERR_MODULE_NOT_FOUND')) {
      throw new Error(
        '@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli',
      )
    }
    throw err
  }
}

const UP_MARKER = '#---------- UP ----------'
const DOWN_MARKER = '#---------- DOWN ----------'

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
