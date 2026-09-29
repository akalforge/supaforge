import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QueryFn } from './db.js'
import { pgQuery } from './db.js'
import type { LocalMigration } from './checks/migrations.js'
import { readLocalMigrations } from './checks/migrations.js'
import type { ReadDirFn } from './checks/migrations.js'
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './constants.js'

// ─── Schema bootstrap ────────────────────────────────────────────────────────

/** SQL to ensure the supabase_migrations schema and table exist. */
export const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA};

CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version text PRIMARY KEY,
  statements text[],
  name text
);
`.trim()

/** Ensure the supabase_migrations schema and table exist. */
export async function ensureMigrationsTable(
  dbUrl: string,
  queryFn: QueryFn = pgQuery,
): Promise<void> {
  await queryFn(dbUrl, BOOTSTRAP_SQL)
}

// ─── Applied versions ────────────────────────────────────────────────────────

const APPLIED_SQL = `
  SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version
`

/** Fetch the set of already-applied migration versions from the target DB. */
export async function getAppliedVersions(
  dbUrl: string,
  queryFn: QueryFn = pgQuery,
): Promise<Set<string>> {
  const rows = await queryFn(dbUrl, APPLIED_SQL) as { version: string }[]
  return new Set(rows.map(r => r.version))
}

// ─── Pending migrations ──────────────────────────────────────────────────────

export interface PendingMigration extends LocalMigration {
  /** Full path to the migration file. */
  path: string
}

/**
 * Determine which local migration files are pending (not yet applied in DB).
 * Returns them in sorted order.
 */
export async function getPendingMigrations(
  dir: string,
  applied: Set<string>,
  readDirFn?: ReadDirFn,
): Promise<PendingMigration[]> {
  const local = await readLocalMigrations(dir, readDirFn)
  return local
    .filter(m => !applied.has(m.version))
    .map(m => ({ ...m, path: join(dir, m.filename) }))
}

// ─── Execute a single migration ──────────────────────────────────────────────

export type ReadFileFn = (path: string) => Promise<string>

const defaultReadFile: ReadFileFn = (path) => readFile(path, 'utf8')

export interface RunMigrationResult {
  version: string
  name: string
  filename: string
  durationMs: number
}

/**
 * Execute a single migration file against the target DB, then record it
 * in schema_migrations.
 */
export async function runMigration(
  dbUrl: string,
  migration: PendingMigration,
  queryFn: QueryFn = pgQuery,
  readFileFn: ReadFileFn = defaultReadFile,
): Promise<RunMigrationResult> {
  const sql = await readFileFn(migration.path)
  const start = performance.now()

  // Execute the migration SQL
  await queryFn(dbUrl, sql)

  // Record in schema_migrations
  await queryFn(
    dbUrl,
    `INSERT INTO ${MIGRATIONS_TABLE} (version, name, statements)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.name, [sql]],
  )

  return {
    version: migration.version,
    name: migration.name,
    filename: migration.filename,
    durationMs: Math.round(performance.now() - start),
  }
}

/**
 * Applied versions, or an empty set when the tracking table does not exist.
 *
 * For read-only paths that must not bring the table into being as a side
 * effect of looking.
 */
async function readAppliedVersionsIfPresent(
  dbUrl: string,
  queryFn: QueryFn,
): Promise<Set<string>> {
  try {
    return await getAppliedVersions(dbUrl, queryFn)
  } catch {
    return new Set()
  }
}

// ─── Baseline (mark all as applied without executing) ────────────────────────

export interface BaselineResult {
  marked: { version: string; name: string }[]
  skipped: { version: string; reason: string }[]
}

/**
 * Mark all local migration files as applied in schema_migrations
 * without actually executing their SQL.
 */
export async function baselineMigrations(
  dbUrl: string,
  dir: string,
  queryFn: QueryFn = pgQuery,
  readDirFn?: ReadDirFn,
  options: { dryRun?: boolean } = {},
): Promise<BaselineResult> {
  const local = await readLocalMigrations(dir, readDirFn)

  // A preview writes nothing at all — not even the tracking table, which on
  // Supabase means creating a schema the project did not have. So under dryRun
  // the applied set is read defensively instead: no table yet means nothing is
  // recorded yet, which is the right answer.
  let applied: Set<string>
  if (options.dryRun) {
    applied = await readAppliedVersionsIfPresent(dbUrl, queryFn)
  } else {
    await ensureMigrationsTable(dbUrl, queryFn)
    applied = await getAppliedVersions(dbUrl, queryFn)
  }

  const result: BaselineResult = { marked: [], skipped: [] }

  for (const migration of local) {
    if (applied.has(migration.version)) {
      result.skipped.push({
        version: migration.version,
        reason: 'already recorded in schema_migrations',
      })
      continue
    }

    // `marked` is what *would* be recorded under dryRun, so the caller can
    // print the same list either way (issue #88).
    if (!options.dryRun) {
      await queryFn(
        dbUrl,
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, statements)
         VALUES ($1, $2, '{}')
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.name],
      )
    }
    result.marked.push({ version: migration.version, name: migration.name })
  }

  return result
}
