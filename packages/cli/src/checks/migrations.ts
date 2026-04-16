import { readdir as fsReaddir } from 'node:fs/promises'
import type { QueryFn } from '../db.js'
import { pgQuery } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { MIGRATIONS_TABLE } from '../constants.js'
import { quoteLiteral } from '../utils/sql.js'
import { Check, type CheckContext } from './base.js'

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

    const [local, db] = await Promise.all([
      readLocalMigrations(dir, this.readDirFn),
      this.fetchDbMigrations(ctx.target.dbUrl),
    ])

    return diffMigrations(local, db)
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

export function diffMigrations(
  local: LocalMigration[],
  db: MigrationRecord[],
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const dbMap = new Map(db.map(r => [r.version, r]))
  const localMap = new Map(local.map(m => [m.version, m]))

  // Local files not recorded in DB (unapplied)
  for (const migration of local) {
    if (!dbMap.has(migration.version)) {
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
