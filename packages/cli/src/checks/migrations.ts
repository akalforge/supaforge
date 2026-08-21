import { readdir as fsReaddir } from 'node:fs/promises'
import type { QueryFn } from '../db.js'
import { pgQuery } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { MIGRATIONS_TABLE } from '../constants.js'
import { quoteLiteral } from '../utils/sql.js'
import { Check, CheckSkipped, type CheckContext } from './base.js'
import type { MigrationsMode } from '../types/config.js'

export const DEFAULT_MIGRATIONS_DIR = 'supabase/migrations'

const MIGRATIONS_SQL = `
  SELECT version, name
  FROM ${MIGRATIONS_TABLE}
  ORDER BY version
`

interface MigrationRecord {
  version: string
  name: string | null
}

export interface LocalMigration {
  version: string
  name: string
  filename: string
}

export type ReadDirFn = (dir: string) => Promise<string[]>

const defaultReadDir: ReadDirFn = async (dir) => {
  const entries = await fsReaddir(dir)
  return entries as string[]
}

export class MigrationsCheck extends Check {
  readonly name = 'migrations' as const

  constructor(
    private queryFn: QueryFn = pgQuery,
    private readDirFn: ReadDirFn = defaultReadDir,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const dir = ctx.config.checks?.migrations?.dir ?? DEFAULT_MIGRATIONS_DIR
    const mode = resolveMigrationsMode(ctx.config.checks?.migrations?.mode)

    // Nothing to read or query when the check is switched off entirely. It is
    // still reported as skipped rather than clean, so turning it off does not
    // look like a layer that passed (issue #42).
    if (mode === 'ignore') throw new CheckSkipped("checks.migrations.mode is 'ignore'")

    const [local, db] = await Promise.all([
      readLocalMigrations(dir, this.readDirFn),
      this.fetchDbMigrations(ctx.target.dbUrl),
    ])

    return diffMigrations(local, db, mode)
  }

  private async fetchDbMigrations(dbUrl: string): Promise<MigrationRecord[]> {
    try {
      return await this.queryFn(dbUrl, MIGRATIONS_SQL) as unknown as MigrationRecord[]
    } catch {
      // schema_migrations table doesn't exist — no records to compare
      return []
    }
  }
}

/**
 * Parse a migration filename into version + name.
 * Handles both `20240101000000_create_users.sql` and `001_initial_schema.sql`.
 */
export function parseFilename(filename: string): { version: string; name: string } | null {
  if (!filename.endsWith('.sql')) return null
  const match = filename.replace(/\.sql$/, '').match(/^(\d+)_(.+)$/)
  if (!match) return null
  return { version: match[1], name: match[2] }
}

export async function readLocalMigrations(
  dir: string,
  readDirFn: ReadDirFn = defaultReadDir,
): Promise<LocalMigration[]> {
  let files: string[]
  try {
    files = (await readDirFn(dir)).filter(f => f.endsWith('.sql')).sort()
  } catch {
    return []
  }

  const migrations: LocalMigration[] = []
  for (const filename of files) {
    const parsed = parseFilename(filename)
    if (!parsed) continue
    migrations.push({ ...parsed, filename })
  }
  return migrations
}

const MIGRATIONS_MODES: MigrationsMode[] = ['auto', 'warn', 'ignore']

/**
 * Normalise the configured mode.
 *
 * An unrecognised value falls back to 'auto' rather than throwing — a typo in
 * a config file should not take the whole scan down, and 'auto' is the least
 * surprising default.
 */
export function resolveMigrationsMode(raw: unknown): MigrationsMode {
  return MIGRATIONS_MODES.includes(raw as MigrationsMode) ? (raw as MigrationsMode) : 'auto'
}

/**
 * One INFO describing a project that applies migrations outside the Supabase
 * CLI, instead of one warning per file.
 *
 * schema_migrations is a Supabase CLI convention, not a database requirement.
 * Projects that apply migrations via psql or the SQL editor never populate it,
 * so every local file was reported as "unapplied" on every scan — all false
 * positives, and enough of them to drown the rest of the layer (issue #31).
 */
function untrackedWorkflowIssue(local: LocalMigration[]): DriftIssue {
  const noun = local.length === 1 ? 'file' : 'files'
  return {
    id: 'migration-workflow-untracked',
    check: 'migrations',
    severity: 'info',
    title: `Untracked migration workflow: ${local.length} local ${noun}, none recorded`,
    description:
      `${MIGRATIONS_TABLE} is empty while ${local.length} migration ${noun} exist locally. ` +
      'That is the normal shape for a project applying migrations outside the Supabase CLI ' +
      '(psql, the SQL editor, or another tool), so each file is not reported separately. ' +
      'Run `supaforge migrate baseline` to record them as applied, or set ' +
      'checks.migrations.mode to "warn" to report every file, or "ignore" to disable this check.',
    sourceValue: `${local.length} local migration ${noun}`,
  }
}

export function diffMigrations(
  local: LocalMigration[],
  db: MigrationRecord[],
  mode: MigrationsMode = 'auto',
): DriftIssue[] {
  if (mode === 'ignore') return []

  const issues: DriftIssue[] = []
  const dbMap = new Map(db.map(r => [r.version, r]))
  const localMap = new Map(local.map(m => [m.version, m]))
  const unapplied = local.filter(m => !dbMap.has(m.version))

  // Nothing tracked at all, but files on disk: report the workflow once
  // rather than each file. Requires db to be *entirely* empty — a project
  // that tracks some migrations and missed others has genuine drift.
  if (mode === 'auto' && db.length === 0 && unapplied.length > 0) {
    issues.push(untrackedWorkflowIssue(local))
  } else {
    for (const migration of unapplied) {
      issues.push({
        id: `migration-unapplied-${migration.version}`,
        check: 'migrations',
        severity: 'warning',
        title: `Unapplied migration: ${migration.filename}`,
        description: `Migration file "${migration.filename}" exists locally but is not recorded in ${MIGRATIONS_TABLE}.`,
        sourceValue: migration.filename,
        sql: {
          up: markAppliedSql(migration.version, migration.name),
          down: `DELETE FROM ${MIGRATIONS_TABLE} WHERE version = ${quoteLiteral(migration.version)};`,
        },
      })
    }
  }

  // DB records without local files (untracked)
  for (const [version, record] of dbMap) {
    if (!localMap.has(version)) {
      issues.push({
        id: `migration-untracked-${version}`,
        check: 'migrations',
        severity: 'info',
        title: `Untracked migration: ${version}`,
        description: `Migration version "${version}"${record.name ? ` (${record.name})` : ''} is recorded in the database but has no corresponding local file.`,
        targetValue: record,
      })
    }
  }

  return issues
}

/** SQL to insert a migration record into schema_migrations (mark as applied). */
function markAppliedSql(version: string, name: string): string {
  return [
    `INSERT INTO ${MIGRATIONS_TABLE} (version, name, statements)`,
    `VALUES (${quoteLiteral(version)}, ${quoteLiteral(name)}, '{}')`,
    `ON CONFLICT (version) DO NOTHING;`,
  ].join('\n')
}
