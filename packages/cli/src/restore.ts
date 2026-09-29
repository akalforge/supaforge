import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { pgClientConfig } from './db.js'
import type { MigrationFile, SnapshotManifest } from './types/config'
import { loadMigrations } from './migration'
import { MIGRATIONS_TABLE } from './constants.js'
import { ensureMigrationsTable, getAppliedVersions } from './migrate.js'
import { loadSnapshot } from './snapshot'
import type { QueryFn } from './db'
import { pgQuery } from './db'
import { errMsg } from './utils/error'
import { DEFAULT_IGNORE_SCHEMAS } from './defaults'
import { dropUnsupportedSetStatements, knownParameters } from './prove'
import { splitSqlStatements, isCommentOnly, isPsqlMetaCommand, stripPsqlMetaCommands } from './utils/sql-split'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface RestoreOptions {
  /** Target database URL to restore into. */
  targetUrl: string
  /** Project ref for API-based operations (auth, storage, edge functions). */
  targetProjectRef?: string
  /** Access token for Supabase Management API. */
  targetAccessToken?: string
  /** Restore from a specific snapshot directory. */
  snapshotDir?: string
  /** Or restore from migrations up to a specific version. */
  toVersion?: string
  /** Starting version (skip migrations before this). */
  fromVersion?: string
  /** Working directory for .supaforge/ */
  cwd?: string
  /** Query function for DB operations. */
  queryFn?: QueryFn
  /** Fetch function for API operations. */
  fetchFn?: FetchFn
}

export interface RestoreResult {
  applied: { type: 'sql' | 'api'; label: string }[]
  skipped: { type: 'sql' | 'api'; label: string; reason: string }[]
  errors: { type: 'sql' | 'api'; label: string; error: string }[]
  mode: 'snapshot' | 'migrations'
}

// ─── Safety Check ────────────────────────────────────────────────────────────

/**
 * Check whether the target database has user tables in the public schema.
 * Returns the table names if any exist — used to gate destructive restore.
 */
export async function getPublicTables(targetUrl: string): Promise<string[]> {
  const ignoreList = DEFAULT_IGNORE_SCHEMAS.map(s => `'${s}'`).join(', ')
  const client = new pg.Client(pgClientConfig(targetUrl))
  await client.connect()
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND schemaname NOT IN (${ignoreList})
       ORDER BY tablename`,
    )
    return rows.map(r => r.tablename)
  } finally {
    await client.end()
  }
}

// ─── Restore from Snapshot ───────────────────────────────────────────────────

/**
 * Restore a Supabase environment from a snapshot directory.
 * Applies all SQL files (schema, RLS, cron, webhooks, extensions, data).
 * API layers (auth, storage buckets, edge functions) log what would need manual action.
 */
export async function restoreFromSnapshot(options: RestoreOptions): Promise<RestoreResult> {
  if (!options.snapshotDir) throw new Error('snapshotDir is required for snapshot restore')

  const result: RestoreResult = { applied: [], skipped: [], errors: [], mode: 'snapshot' }
  const manifest = await loadSnapshot(options.snapshotDir)

  // Apply SQL layers in dependency order
  const sqlOrder = ['extensions', 'schema', 'rls', 'cron', 'webhooks', 'storage-policies']
  const client = new pg.Client(pgClientConfig(options.targetUrl))
  await client.connect()

  try {
    for (const layer of sqlOrder) {
      const file = layerRestoreFile(layer)
      const info = manifest.layers[layer === 'storage-policies' ? 'storage' : layer]
      if (!info?.captured) {
        result.skipped.push({ type: 'sql', label: `Layer: ${layer}`, reason: 'Not captured in snapshot' })
        continue
      }

      // The schema layer's own file is introspection JSON, not DDL; `schema.sql`
      // is the replayable companion (issue #80). Say which it is and why when
      // it is not there, rather than reporting "File not readable" — that
      // sends the reader looking for a permissions problem, and the schema
      // silently not being restored is the whole of the bug.
      if (layer === 'schema' && !(await isReadable(join(options.snapshotDir, file)))) {
        result.skipped.push({
          type: 'sql',
          label: `Layer: ${layer}`,
          reason: info.sqlSkipReason
            ?? 'this snapshot has no schema.sql — it predates one being written, so the '
             + 'schema cannot be replayed. Use `supaforge clone`, or '
             + '`restore --from-migrations`.',
        })
        continue
      }

      try {
        const raw = await readFile(join(options.snapshotDir, file), 'utf-8')
        const content = layer === 'schema'
          ? await replayableSchemaSql(raw, options.targetUrl)
          : raw
        const statements = extractExecutableStatements(content)
        for (const sql of statements) {
          try {
            await client.query(sql)
            result.applied.push({ type: 'sql', label: summarizeStatement(sql) })
          } catch (err) {
            result.errors.push({
              type: 'sql',
              label: summarizeStatement(sql),
              error: errMsg(err),
            })
          }
        }
      } catch {
        result.skipped.push({ type: 'sql', label: `Layer: ${layer}`, reason: 'File not readable' })
      }
    }

    // Apply data if present
    if (manifest.layers.data?.captured) {
      try {
        const dataDir = join(options.snapshotDir, 'data')
        const { readdir } = await import('node:fs/promises')
        const dataFiles = await readdir(dataDir)
        for (const file of dataFiles.filter(f => f.endsWith('.sql')).sort()) {
          const content = await readFile(join(dataDir, file), 'utf-8')
          const statements = extractExecutableStatements(content)
          for (const sql of statements) {
            try {
              await client.query(sql)
              result.applied.push({ type: 'sql', label: `Data: ${file}` })
            } catch (err) {
              result.errors.push({
                type: 'sql',
                label: `Data: ${file}`,
                error: errMsg(err),
              })
            }
          }
        }
      } catch { /* no data dir */ }
    }
  } finally {
    await client.end()
  }

  // Note API layers that need manual action
  if (manifest.layers.auth?.captured) {
    result.skipped.push({
      type: 'api',
      label: 'Auth config',
      reason: 'Requires --project-ref and --api-key to restore via Management API',
    })
  }
  if (manifest.layers['edge-functions']?.captured) {
    result.skipped.push({
      type: 'api',
      label: 'Edge Functions',
      reason: 'Deploy via "supabase functions deploy" from your local functions directory',
    })
  }

  return result
}

// ─── Restore from Migrations ─────────────────────────────────────────────────

/**
 * Restore by replaying migration files in order.
 * Tracks applied migrations in a `_supaforge_migrations` table.
 */
export async function restoreFromMigrations(options: RestoreOptions): Promise<RestoreResult> {
  const cwd = options.cwd ?? process.cwd()
  const result: RestoreResult = { applied: [], skipped: [], errors: [], mode: 'migrations' }
  const queryFn = options.queryFn ?? pgQuery

  const migrations = await loadMigrations(cwd)
  if (migrations.length === 0) {
    result.skipped.push({ type: 'sql', label: 'No migrations', reason: 'No migration files found in .supaforge/migrations/' })
    return result
  }

  // Filter by version range
  let filtered = migrations
  if (options.fromVersion) {
    filtered = filtered.filter(m => m.version >= options.fromVersion!)
  }
  if (options.toVersion) {
    filtered = filtered.filter(m => m.version <= options.toVersion!)
  }

  // Ensure tracking table exists
  const client = new pg.Client(pgClientConfig(options.targetUrl))
  await client.connect()

  try {
    // Tracked in `supabase_migrations.schema_migrations` — the same table
    // `migrate run` uses, in a schema the Data API does not expose.
    //
    // It used to be `public._supaforge_migrations`, created unqualified. On
    // Supabase a table in `public` receives the project's default grants to
    // `anon` and `authenticated`, and this one was created with RLS off — so
    // anyone holding the public anon key could read it, insert into it and
    // delete from it through the Data API, and thereby decide which migrations
    // a later restore believed were already applied (issue #93). It was also a
    // second, disagreeing record of the same thing.
    await ensureMigrationsTable(options.targetUrl, queryFn)

    const legacy = await findLegacyTrackingTable(client)
    if (legacy) {
      result.skipped.push({
        type: 'sql',
        label: 'public._supaforge_migrations',
        reason: 'left over from an earlier version and reachable with the anon key — '
          + 'tracking has moved to supabase_migrations.schema_migrations. '
          + 'Drop it: DROP TABLE public._supaforge_migrations;',
      })
    }

    const applied = await getAppliedVersions(options.targetUrl, queryFn)

    for (const migration of filtered) {
      if (applied.has(migration.version)) {
        result.skipped.push({ type: 'sql', label: `v${migration.version}`, reason: 'Already applied' })
        continue
      }

      // Apply SQL statements
      let ran = 0
      for (const sql of migration.up.sql) {
        if (isCommentOnly(sql)) continue // marker text, not a statement
        try {
          await client.query(sql)
          ran++
          result.applied.push({ type: 'sql', label: summarizeStatement(sql) })
        } catch (err) {
          result.errors.push({
            type: 'sql',
            label: summarizeStatement(sql),
            error: errMsg(err),
          })
        }
      }

      // A migration that applied nothing is not applied.
      //
      // `snapshot --migration` writes files whose schema layer is the comment
      // `-- Schema changed. Use @dbdiff/cli to generate migration SQL.`, and
      // the baseline `clone` writes has no statements at all. Recording those
      // as done meant a restore into an empty database built nothing and then
      // reported success — and left the tracking table asserting the schema
      // was in place (issue #93).
      if (ran === 0) {
        result.skipped.push({
          type: 'sql',
          label: `v${migration.version}`,
          reason: 'carries no SQL to apply, so it was not recorded as applied. '
            + 'Snapshot-derived migrations hold no schema DDL — use '
            + '`supaforge clone`, or restore from a snapshot, to build structure.',
        })
        continue
      }

      await queryFn(
        options.targetUrl,
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, statements)
         VALUES ($1, $2, '{}')
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.description],
      )
    }
  } finally {
    await client.end()
  }

  return result
}

// ─── Preview (Dry-Run) ──────────────────────────────────────────────────────

/** Preview what a snapshot restore would apply (no DB connection required). */
export async function previewSnapshotRestore(snapshotDir: string): Promise<{ layer: string; statements: string[] }[]> {
  const manifest = await loadSnapshot(snapshotDir)
  const preview: { layer: string; statements: string[] }[] = []

  const sqlOrder = ['extensions', 'schema', 'rls', 'cron', 'webhooks', 'storage-policies']
  for (const layer of sqlOrder) {
    const file = layerRestoreFile(layer)
    const info = manifest.layers[layer === 'storage-policies' ? 'storage' : layer]
    if (!info?.captured) continue

    try {
      const content = await readFile(join(snapshotDir, file), 'utf-8')
      const statements = extractExecutableStatements(content)
      if (statements.length > 0) {
        preview.push({ layer, statements })
      }
    } catch { /* skip */ }
  }

  return preview
}

/** Preview what migration restore would apply. */
export async function previewMigrationRestore(cwd = process.cwd(), toVersion?: string, fromVersion?: string): Promise<MigrationFile[]> {
  let migrations = await loadMigrations(cwd)
  if (fromVersion) migrations = migrations.filter(m => m.version >= fromVersion)
  if (toVersion) migrations = migrations.filter(m => m.version <= toVersion)
  return migrations
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Whether a snapshot file exists and can be read. */
async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The schema dump, with preamble settings the target does not have removed.
 *
 * pg_dump writes its preamble for its own version, so a snapshot taken with a
 * PostgreSQL 17 client carries `SET transaction_timeout = 0`, which a 15 or 16
 * server rejects — and the restore would fail on the first line of the schema.
 * The same filtering `--prove` applies for the same reason (issue #72).
 *
 * If the target cannot be asked what it supports, the dump is replayed as-is:
 * a failure there is a real failure, and guessing which settings to drop would
 * be worse than reporting it.
 */
async function replayableSchemaSql(sql: string, targetUrl: string): Promise<string> {
  try {
    return dropUnsupportedSetStatements(sql, await knownParameters(targetUrl)).sql
  } catch {
    return sql
  }
}

function layerRestoreFile(layer: string): string {
  switch (layer) {
    case 'extensions': return 'extensions.sql'
    case 'schema': return 'schema.sql'
    case 'rls': return 'rls.sql'
    case 'cron': return 'cron.sql'
    case 'webhooks': return 'webhooks.sql'
    case 'storage-policies': return 'storage-policies.sql'
    default: return `${layer}.sql`
  }
}

/** Blank lines and comment lines ahead of the statement's first real token. */
const LEADING_NOISE = /^(?:[ \t]*(?:--[^\n]*)?\n)*[ \t]*/

/** `CREATE SCHEMA x`, at the point the statement actually begins. */
const OPENS_CREATE_SCHEMA = /^CREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)/i

/**
 * Make a `CREATE SCHEMA` conditional, if that is what this statement is.
 *
 * Both the test and the rewrite are anchored past pg_dump's comment header
 * rather than applied to the statement as a whole. Matching anywhere reaches
 * into routine bodies — a function running `EXECUTE 'CREATE SCHEMA x'` would
 * have had its body rewritten, changing what the function does.
 */
function makeCreateSchemaConditional(statement: string): string {
  const lead = LEADING_NOISE.exec(statement)?.[0] ?? ''
  const body = statement.slice(lead.length)

  if (!OPENS_CREATE_SCHEMA.test(body)) return statement
  return lead + body.replace(/^CREATE\s+SCHEMA\s+/i, 'CREATE SCHEMA IF NOT EXISTS ')
}

function extractExecutableStatements(content: string): string[] {
  if (!content) return []

  // `\restrict` / `\unrestrict` go first: they end at the newline, not at a
  // semicolon, so removing them after splitting would take the statement they
  // are sitting above with them.
  const sql = stripPsqlMetaCommands(content)

  // A real pg_dump cannot be split on `;` — routine bodies are dollar-quoted
  // and contain their own semicolons (issue #80).
  return splitSqlStatements(sql)
    .filter(s => !isCommentOnly(s))
    .filter(s => !isPsqlMetaCommand(s))
    // A dump scoped to `--schema=public` recreates the schema, and every
    // database already has `public`. Making it conditional keeps a genuinely
    // new schema (`CREATE SCHEMA reporting`) working while restoring into an
    // existing database stops failing on line one.
    .map(makeCreateSchemaConditional)
    .map(s => s.endsWith(';') ? s : `${s};`)
}

export function summarizeStatement(sql: string): string {
  // Blank lines are not the statement. Skipping only comment lines meant a
  // dump's `-- header\n-- 2 extensions\n\nCREATE EXTENSION …` summarised as the
  // empty line between them, so restore reported `✓ [sql]` with nothing after
  // it and, worse, `✗ [sql] : policy … already exists` — an error with no
  // indication of which statement produced it (issue #80).
  const first = sql
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('--'))
    ?? sql.trim()
  return first.length > 80 ? `${first.slice(0, 77)}...` : first
}

/**
 * The `public._supaforge_migrations` table an earlier version created.
 *
 * Worth naming rather than ignoring: it is reachable with the project's anon
 * key, so it should be dropped rather than merely abandoned (issue #93).
 */
async function findLegacyTrackingTable(client: pg.Client): Promise<boolean> {
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '_supaforge_migrations'`,
    )
    return rows.length > 0
  } catch {
    return false
  }
}
