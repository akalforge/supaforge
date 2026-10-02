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
import { DEFAULT_IGNORE_SCHEMAS, SUPABASE_PLATFORM_SCHEMAS } from './defaults'
import { dropUnsupportedSetStatements, knownParameters } from './prove'
import { splitSqlStatements, isCommentOnly, isPsqlMetaCommand, stripPsqlMetaCommands } from './utils/sql-split'
import { quoteIdent, quoteLiteral } from './utils/sql.js'
import { sqlSkeleton, statementSubject } from './sql-deps.js'
import {
  replaceableSchemas, findExternalDependents, dropSchemaContents, recreateExternalDependents,
  resetRelationGrants, type ExternalDependent,
} from './restore-replace.js'

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
  /**
   * Apply each statement on its own, keeping whatever succeeds.
   *
   * Off by default. A restore used to run this way always, so a failure part
   * way through left a half-restored database and the errors were listed only
   * at the end (issue #95). PostgreSQL has transactional DDL, so the whole
   * restore now succeeds or leaves the target exactly as it was.
   */
  noTransaction?: boolean
  /**
   * Drop the schemas the snapshot covers before replaying into them.
   *
   * What `--force` now means. It used to only skip the "target is not empty"
   * check, so restoring over an existing database failed on every object that
   * was already there and replaced nothing (issue #95).
   */
  replace?: boolean
}

export interface RestoreResult {
  applied: { type: 'sql' | 'api'; label: string }[]
  skipped: { type: 'sql' | 'api'; label: string; reason: string }[]
  errors: { type: 'sql' | 'api'; label: string; error: string }[]
  mode: 'snapshot' | 'migrations'
  /**
   * Statements that ran and were then rolled back, when the restore was
   * transactional and something failed.
   *
   * Reported apart from `applied`, which is emptied: a restore that rolled
   * back applied nothing, and saying it applied 60 operations would be the
   * most misleading thing this command could tell anyone (issue #95).
   */
  rolledBack?: { type: 'sql' | 'api'; label: string }[]
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
  const sqlOrder = RESTORE_SQL_ORDER
  const client = new pg.Client(pgClientConfig(options.targetUrl))
  await client.connect()

  // One transaction for the lot, unless asked otherwise. A restore that fails
  // half way used to leave a database matching neither the snapshot nor its own
  // previous state, with the errors reported only at the end (issue #95).
  // PostgreSQL has transactional DDL, so this is the same guarantee `--apply`
  // gives in promote().
  const transactional = !options.noTransaction
  if (transactional) await client.query('BEGIN')

  /** Webhook triggers the schema dump creates, so the webhooks layer can skip them. */
  const createdBySchemaLayer = new Set<string>()

  /** Triggers and policies outside the cleared schemas, to put back — see restore-replace. */
  let external: ExternalDependent[] = []

  // schema.sql is a pg_dump, which empties search_path for the rest of the
  // session. Every later layer holds names as the catalog rendered them —
  // unqualified where they resolved through the default path — so a storage
  // policy calling `is_admin()` failed with "function is_admin() does not
  // exist" and, in one transaction, took the whole restore with it. The
  // session's own path is put back after each layer.
  const { rows: [{ search_path: sessionSearchPath }] } =
    await client.query<{ search_path: string }>('SHOW search_path')

  try {
    // `--force` means replace, not "carry on regardless". Skipping the
    // not-empty check and then failing on every object that already exists
    // replaced nothing at all. What it clears, and what it must not, is in
    // restore-replace.ts.
    if (options.replace) {
      const schemas = replaceableSchemas(await schemasInSnapshot(options.snapshotDir))
      const dependents = await findExternalDependents(client, schemas)
      if (dependents.blockers.length > 0) {
        result.errors.push({
          type: 'sql',
          label: 'Restore --force',
          error: `clearing ${schemas.join(', ')} would also drop objects outside them that `
            + `this restore cannot put back: ${dependents.blockers.join('; ')}. `
            + 'Nothing was changed. Remove or move those first, or restore into an empty database.',
        })
        throw new RestoreAborted()
      }
      external = dependents.recreate
      const dropped = await dropSchemaContents(client, schemas)
      result.applied.push({
        type: 'sql',
        label: `Cleared ${dropped} object(s) from ${schemas.join(', ')} (--force)`,
      })
    }

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

        let statements = extractExecutableStatements(content)

        // Grants are restored exactly, not added to whatever default
        // privileges gave the recreated objects — see resetRelationGrants.
        if (layer === 'roles') {
          const reset = await resetRelationGrants(
            client, replaceableSchemas(await schemasInSnapshot(options.snapshotDir)))
          if (reset > 0) {
            result.applied.push({ type: 'sql', label: `Reset grants on ${reset} relation(s) before replaying the captured ones` })
          }
        }

        // Objects the platform owns cannot be recreated by `postgres`, and a
        // snapshot of a Supabase project carries several: `pgbouncer.get_auth`
        // in the schema dump, pg_cron's own policies on `cron.job` in the RLS
        // dump. They failed on every single restore (issue #95).
        statements = statements.filter(sql => {
          const owner = platformOwnedObject(sql)
          if (owner === undefined) return true
          result.skipped.push({
            type: 'sql',
            label: summarizeStatement(sql),
            reason: `${owner} is managed by the platform and cannot be recreated here`,
          })
          return false
        })

        // The webhooks layer re-creates triggers the schema dump already made
        // — the restore-side twin of the overlap #77 settled for `diff --apply`.
        if (layer === 'webhooks') {
          statements = statements.filter(sql => {
            if (!createdBySchemaLayer.has(webhookTriggerKey(sql) ?? '')) return true
            result.skipped.push({
              type: 'sql',
              label: summarizeStatement(sql),
              reason: 'already created by the schema layer',
            })
            return false
          })
        }

        if (layer === 'schema') {
          for (const sql of statements) {
            const key = webhookTriggerKey(sql)
            if (key) createdBySchemaLayer.add(key)
          }
        }

        for (const sql of statements) {
          await applyStatement(client, sql, transactional, result)
        }
      } catch (err) {
        if (err instanceof RestoreAborted) throw err
        result.skipped.push({ type: 'sql', label: `Layer: ${layer}`, reason: 'File not readable' })
      }
      await client.query(`SELECT set_config('search_path', $1, false)`, [sessionSearchPath])
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
              // As for the SQL layers: in a transaction everything after the
              // first failure only reports that the transaction is aborted.
              if (transactional) throw new RestoreAborted()
            }
          }
        }
      } catch (err) {
        if (err instanceof RestoreAborted) throw err
        /* no data dir */
      }
    }

    // What clearing the schemas took with it from outside them — the auth
    // trigger that calls a public function, a storage policy that does —
    // goes back once everything it depends on exists again.
    for (const dep of await recreateExternalDependents(client, external)) {
      result.applied.push({
        type: 'sql',
        label: `Recreated ${dep.kind} ${dep.name} on ${dep.schema}.${dep.table} (outside the snapshot, dropped by --force)`,
      })
    }

    if (transactional) {
      if (result.errors.length > 0) {
        await client.query('ROLLBACK')
        // Nothing was written, so nothing was applied. Reporting otherwise
        // would be the most misleading thing this command could say.
        result.rolledBack = result.applied
        result.applied = []
      } else {
        await client.query('COMMIT')
      }
    }
  } catch (err) {
    if (transactional) {
      await client.query('ROLLBACK').catch(() => undefined)
      result.rolledBack = result.applied
      result.applied = []
    }
    // A RestoreAborted carries no message of its own: the statement that failed
    // has already been recorded, and adding a second entry for the same
    // failure would only make it harder to read.
    if (!(err instanceof RestoreAborted)) {
      result.errors.push({ type: 'sql', label: 'Restore', error: errMsg(err) })
    }
  } finally {
    await client.end()
  }

  // Layers that were captured and cannot be replayed as SQL. Named
  // individually rather than left out: a restore that lists what it did and
  // says nothing about four of the twelve layers reads as complete when it is
  // not, which is the thing a restore most needs to be honest about.
  for (const note of MANUAL_LAYERS) {
    if (manifest.layers[note.layer]?.captured) {
      result.skipped.push({ type: note.type, label: note.label, reason: note.reason })
    }
  }

  return result
}

/** Captured layers a restore cannot replay, and what to do about each. */
const MANUAL_LAYERS: ReadonlyArray<{
  layer: string
  type: 'api' | 'sql'
  label: string
  reason: string
}> = [
  {
    layer: 'auth',
    type: 'api',
    label: 'Auth config',
    reason: 'Requires --project-ref and --api-key to restore via Management API',
  },
  {
    layer: 'edge-functions',
    type: 'api',
    label: 'Edge Functions',
    reason: 'Deploy via "supabase functions deploy" from your local functions directory',
  },
  {
    // storage-policies.sql *is* replayed; the bucket rows are not. They are
    // created over the Storage API, which needs credentials a restore into a
    // plain PostgreSQL database does not have.
    layer: 'storage',
    type: 'api',
    label: 'Storage buckets',
    reason: 'Bucket rows are created via the Storage API. The policies on them are replayed from '
      + 'storage-policies.sql where the target has a storage schema; objects are never transferred',
  },
  {
    layer: 'vault',
    type: 'sql',
    label: 'Vault secrets',
    reason: 'vault.sql lists the secret names only — a value cannot be read out of Vault, '
      + 'so each must be recreated by hand with vault.create_secret',
  },
]

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

  const sqlOrder = RESTORE_SQL_ORDER
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

/**
 * The snapshot layers a restore replays, in dependency order.
 *
 * `realtime` and `roles` were captured as replayable SQL and then never
 * replayed: the two layers were added to `snapshot` without being added here,
 * so a restore silently dropped every publication membership and every table
 * grant the snapshot held. Both come after `schema`, because a publication can
 * only add a table that exists and a grant can only name one.
 *
 * `vault` is deliberately absent — its file is a comment-only list of secret
 * names, because a secret's value cannot be read out of Vault and inventing one
 * is worse than leaving it absent (issue #91). It is reported as needing manual
 * action instead, alongside the API layers.
 */
const RESTORE_SQL_ORDER = [
  'extensions', 'schema', 'rls', 'cron', 'webhooks', 'storage-policies', 'realtime', 'roles',
]

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

/**
 * The schemas a snapshot's `schema.sql` creates.
 *
 * Used by `--force` to clear the ground before replaying. Read from the dump
 * rather than assumed to be `public`, so a snapshot covering `reporting` as
 * well does not leave half of it behind — and so nothing outside the snapshot
 * is touched.
 */
async function schemasInSnapshot(snapshotDir: string): Promise<string[]> {
  try {
    const sql = await readFile(join(snapshotDir, 'schema.sql'), 'utf-8')
    const found = new Set<string>()

    for (const match of sql.matchAll(/^\s*CREATE SCHEMA (?:IF NOT EXISTS )?("[^"]+"|[A-Za-z_][\w$]*)/gim)) {
      found.add(match[1].replace(/"/g, ''))
    }

    // A dump scoped to public may not carry a CREATE SCHEMA for it at all.
    found.add('public')
    return [...found]
  } catch {
    return ['public']
  }
}


/**
 * Schemas whose contents belong to the platform, not the project.
 *
 * A Supabase snapshot captures objects in these that `postgres` cannot
 * recreate — `pgbouncer.get_auth()` needs the `pgbouncer` role, and pg_cron
 * owns its own policies on `cron.job` — so every restore failed on them
 * (issue #95). They are the project's to read, never to rebuild.
 */
const PLATFORM_OWNED_SCHEMAS = ['pgbouncer', 'cron', 'pgsodium', 'vault', '_realtime', 'supabase_functions']

/**
 * The platform-owned object a statement creates or changes, if any.
 *
 * Decided by the statement's *subject* — what it acts on — not by every schema
 * it mentions. `CREATE TRIGGER ... ON public.orders EXECUTE FUNCTION
 * supabase_functions.http_request(...)` is a Database Webhook, the project's
 * own, and matching by mention skipped every one of them on restore, along
 * with any view that reads `cron.job_run_details` or `vault.decrypted_secrets`.
 *
 * Returns the schema so the skip can say which it was.
 */
export function platformOwnedObject(sql: string): string | undefined {
  const subject = statementSubject(sql)
  if (!subject?.schema) return undefined
  return PLATFORM_OWNED_SCHEMAS.includes(subject.schema) ? subject.schema : undefined
}

/**
 * Schemas only a Supabase instance has. A statement naming one of them can
 * fail on plain PostgreSQL for no reason but that — see `tolerableFailure`.
 */
const SUPABASE_ONLY_SCHEMAS = [
  ...new Set([...SUPABASE_PLATFORM_SCHEMAS, ...PLATFORM_OWNED_SCHEMAS]),
].filter(s => s !== 'pg_catalog' && s !== 'information_schema')

/**
 * The Supabase-only schema a statement names that the target lacks, if any.
 */
export function mentionedPlatformSchema(
  sql: string,
  targetSchemas: ReadonlySet<string>,
): string | undefined {
  const skeleton = sqlSkeleton(sql)
  return SUPABASE_ONLY_SCHEMAS.find(schema =>
    !targetSchemas.has(schema)
    && new RegExp(String.raw`(?:"${schema}"|\b${schema})\s*\.`, 'i').test(skeleton))
}

/**
 * SQLSTATEs meaning "that does not exist here": a relation, function, schema
 * or object missing.
 */
const ABSENT_ON_TARGET = new Set(['42P01', '42883', '3F000', '42704'])

/** SQLSTATEs for an extension the server does not ship. */
const EXTENSION_UNAVAILABLE = new Set(['0A000', '58P01'])

/**
 * Statements that attach to an object rather than define one: a grant, a
 * policy, a trigger, a view, a comment, a foreign key, publication
 * membership, a cron call. Only these may be skipped — a table or a column
 * that cannot be created fails the restore, however it fails.
 */
const ATTACHMENT = new RegExp(String.raw`^\s*(?:`
  + String.raw`GRANT|REVOKE|COMMENT\s+ON|SELECT|ALTER\s+PUBLICATION|ALTER\s+DEFAULT\s+PRIVILEGES|`
  + String.raw`ALTER\s+POLICY|ALTER\s+TABLE\s+(?:ONLY\s+)?\S+\s+ADD\s+CONSTRAINT\b[\s\S]*\bFOREIGN\s+KEY|`
  + String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:POLICY|(?:CONSTRAINT\s+)?TRIGGER|VIEW|MATERIALIZED\s+VIEW|RULE)`
  + String.raw`)\b`, 'i')

/**
 * Why a failed statement can be skipped instead of failing the restore, or
 * undefined when it cannot.
 *
 * A Supabase snapshot restored into plain PostgreSQL carries things that
 * cannot exist there: `pg_graphql`, a Database Webhook calling
 * `supabase_functions.http_request`, a grant on `storage.objects`, a policy
 * calling `auth.uid()`, a foreign key to `auth.users`. In one transaction the
 * first of them rolled back the whole restore — nothing applied at all.
 *
 * So they are skipped by name, under three conditions together: the
 * statement only attaches to something (ATTACHMENT), PostgreSQL's error says
 * something is missing, and the Supabase schema it names does not exist on
 * this target at all. On a Supabase target every such schema exists, so
 * nothing there is ever skipped this way; and a table that cannot be created
 * fails the restore wherever it is. An extension the server does not ship is
 * skipped on its own terms.
 *
 * @param targetSchemas the schemas the target has, read after the failure
 */
export function tolerableFailure(
  sql: string,
  err: unknown,
  targetSchemas: ReadonlySet<string>,
): string | undefined {
  const code = (err as { code?: string } | null)?.code
  if (!code) return undefined
  const skeleton = sqlSkeleton(sql)

  if (/^\s*CREATE\s+EXTENSION\b/i.test(skeleton)) {
    return EXTENSION_UNAVAILABLE.has(code)
      ? `extension not available on this server: ${errMsg(err)}`
      : undefined
  }
  if (!ABSENT_ON_TARGET.has(code) || !ATTACHMENT.test(skeleton)) return undefined

  const schema = mentionedPlatformSchema(sql, targetSchemas)
  return schema
    ? `depends on ${schema}, which this target does not have (${errMsg(err)})`
    : undefined
}

/**
 * Run one restore statement, with what it needs prepared first.
 *
 * In a transaction each statement runs under a savepoint, so a failure that
 * `tolerableFailure` accepts is undone on its own and the restore continues;
 * any other failure aborts the lot.
 */
async function applyStatement(
  client: pg.Client,
  sql: string,
  transactional: boolean,
  result: RestoreResult,
): Promise<void> {
  if (transactional) await client.query('SAVEPOINT sf_restore_statement')
  try {
    // `CREATE EXTENSION ... WITH SCHEMA "extensions"` needs that schema to
    // exist, and on plain PostgreSQL it does not (issue #95).
    const needed = extensionTargetSchema(sql)
    if (needed) await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(needed)}`)

    // `GRANT … TO anon` and `CREATE POLICY … TO service_role` need the role to
    // exist, and on plain PostgreSQL none of Supabase's Data API roles do.
    for (const role of rolesToCreate(sql)) await client.query(createRoleIfMissing(role))

    await client.query(conditionalPublicationMembership(sql))
    if (transactional) await client.query('RELEASE SAVEPOINT sf_restore_statement')
    result.applied.push({ type: 'sql', label: summarizeStatement(sql) })
  } catch (err) {
    // Back to the savepoint first: until then the transaction accepts no
    // query, and deciding needs one.
    if (transactional) await client.query('ROLLBACK TO SAVEPOINT sf_restore_statement')
    const { rows } = await client.query<{ nspname: string }>('SELECT nspname FROM pg_namespace')
    const tolerated = tolerableFailure(sql, err, new Set(rows.map(r => r.nspname)))
    if (tolerated) {
      result.skipped.push({ type: 'sql', label: summarizeStatement(sql), reason: tolerated })
      return
    }
    result.errors.push({ type: 'sql', label: summarizeStatement(sql), error: errMsg(err) })
    // In a transaction, stop at the first real failure and let the rollback
    // handle it: everything after would only report the transaction aborted.
    if (transactional) throw new RestoreAborted()
  }
}

/**
 * `schema.table.trigger` for a statement creating a webhook trigger, else null.
 *
 * A trigger name is unique only per table, which is the same keying the
 * webhooks check settled on in #77.
 */
export function webhookTriggerKey(sql: string): string | null {
  const match = /CREATE\s+TRIGGER\s+("[^"]+"|[\w$]+)[\s\S]*?\bON\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i
    .exec(sqlSkeleton(sql))
  if (!match) return null

  const bare = (s: string) => s.replace(/"/g, '').trim()
  return `${bare(match[2])}.${bare(match[1])}`.toLowerCase()
}

/**
 * A schema that already exists everywhere and cannot be created.
 *
 * PostgreSQL rejects a name beginning with `pg_` before it even evaluates
 * `IF NOT EXISTS`, so asking for one is an error rather than a no-op — the
 * same trap as issue #94, which is where `--prove` used to abort.
 */
export function isSystemSchema(schema: string): boolean {
  return schema === 'pg_catalog' || schema === 'information_schema' || schema.startsWith('pg_')
}

/**
 * The schema a `CREATE EXTENSION ... WITH SCHEMA x` needs creating first, if any.
 *
 * A Supabase snapshot puts its extensions in `extensions`, which plain
 * PostgreSQL has never heard of, so every one of them failed there with
 * `schema "extensions" does not exist` (issue #95).
 *
 * System schemas are excluded. `plpgsql` lives in `pg_catalog`, and asking for
 * that one aborts the transaction and takes the whole restore with it — which
 * is what a first attempt at this fix did.
 */
export function extensionTargetSchema(sql: string): string | undefined {
  const match = /CREATE\s+EXTENSION\b[\s\S]*?\bWITH\s+SCHEMA\s+("[^"]+"|[\w$]+)/i
    .exec(sqlSkeleton(sql))
  if (!match) return undefined

  const schema = match[1].replace(/"/g, '')
  return isSystemSchema(schema) ? undefined : schema
}

/** Role specifications that are keywords rather than roles, so never created. */
const ROLE_KEYWORDS = new Set(['public', 'current_user', 'current_role', 'session_user'])

/**
 * Every role a statement grants to or scopes a policy to, which a restore
 * creates first if the target lacks it.
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
export function rolesToCreate(sql: string): string[] {
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

/**
 * `CREATE ROLE` guarded on the role not already existing.
 *
 * PostgreSQL has no `CREATE ROLE IF NOT EXISTS`, so this is the DO-block form.
 * `NOLOGIN`, deliberately: these are grant targets, and a restore quietly
 * creating a role that can log in would be a worse outcome than a failed grant.
 */
export function createRoleIfMissing(role: string): string {
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    CREATE ROLE ${quoteIdent(role)} NOLOGIN;
  END IF;
END $$;`
}

/**
 * `ALTER PUBLICATION … ADD TABLE` guarded on the table not already being in it.
 *
 * Adding a table twice is an error — `relation "orders" is already member of
 * publication` — so restoring the realtime layer into a database that already
 * has the publication populated aborted the whole transaction. Every other
 * statement a restore replays is either idempotent or made so (the same reason
 * `CREATE SCHEMA` is rewritten), and this is the one that was not.
 *
 * Anything that is not such a statement is returned unchanged.
 */
export function conditionalPublicationMembership(sql: string): string {
  const match = /^\s*ALTER\s+PUBLICATION\s+("[^"]+"|[\w$]+)\s+ADD\s+TABLE\s+(?:ONLY\s+)?([^;]+?)\s*;?\s*$/i
    .exec(sql)
  if (!match) return sql

  const [, publication, table] = match
  const parts = table.split('.').map(p => p.replace(/"/g, '').trim())
  if (parts.length !== 2) return sql

  const [schema, name] = parts
  return `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = ${quoteLiteral(publication.replace(/"/g, ''))}
      AND schemaname = ${quoteLiteral(schema)}
      AND tablename = ${quoteLiteral(name)}
  ) THEN
    EXECUTE ${quoteLiteral(`ALTER PUBLICATION ${quoteIdent(publication.replace(/"/g, ''))} ADD TABLE ${quoteIdent(schema)}.${quoteIdent(name)}`)};
  END IF;
END $$;`
}

/** Thrown to unwind out of the layer loop once a transaction has aborted. */
class RestoreAborted extends Error {}
