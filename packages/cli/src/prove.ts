/**
 * Convergence proof.
 *
 * A migration is only trustworthy if applying it actually produces the target
 * schema. Every silent-wrong-answer bug found so far shared one shape: the
 * generated SQL executed without error and left the database in a state that
 * was *not* the source — a duplicate primary key aborted loudly, but a
 * flattened partition, a dropped enum type name and an unpropagated index all
 * ran cleanly and lied.
 *
 * A text comparison cannot catch that class, and neither can a test suite that
 * only exercises the patterns its authors thought of. The only check that
 * generalises is to run the migration and look at what came out.
 *
 * So: copy the target's schema into a throwaway database, apply the migration
 * there, and diff the result against the source. Zero drift means the migration
 * does what it claims. Anything else is reported as residual drift, naming the
 * objects the migration failed to reproduce.
 *
 * The real target is never touched. The clone lives on the target's own server
 * (so no cross-host credentials are needed) and is dropped in a finally block
 * even when the proof throws.
 */
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { pgQuery } from './db'
import { resolvePgDumpPath, getServerMajorVersion } from './pg-tools'
import { join, dirname } from 'node:path'

const exec = promisify(execFile)

/** Schemas Supabase manages; cloning them adds minutes and proves nothing. */
const PROOF_EXCLUDED_SCHEMAS = [
  'auth', 'storage', 'realtime', '_realtime', 'vault', 'extensions',
  'graphql', 'graphql_public', 'supabase_migrations', 'supabase_functions',
  'pgsodium', 'pgsodium_masks', 'net', 'cron', '_analytics', '_supavisor',
]

export interface ProofResult {
  /** True when the clone matched the source after applying. */
  converged: boolean
  /** Objects still differing after the migration — the migration's blind spots. */
  residual: string[]
  /** Name of the throwaway database, for error messages. */
  cloneName: string
  /** Set when the proof could not run at all (missing pg_dump, no CREATEDB). */
  skipped?: string
}

/** Replace the database name in a libpq URL, keeping everything else. */
function withDatabase(dbUrl: string, database: string): string {
  const url = new URL(dbUrl)
  url.pathname = `/${database}`
  return url.toString()
}


/**
 * Structural fingerprint of one database.
 *
 * Deliberately reads the catalog rather than information_schema: relkind is how
 * you tell a partitioned table from an ordinary one, and relpartbound is the
 * only place the partition bound exists. Both were invisible to the
 * information_schema view that let partition flattening go unnoticed.
 *
 * Indexes are compared per-relation, so an index created ON ONLY the parent —
 * which never reaches the partitions — shows up as the difference it is.
 *
 * Every object that carries a body is compared *by that body*, not by its name.
 * Comparing names alone made the proof unable to see a view whose WHERE clause
 * had been inverted, a function whose entire implementation had changed, or a
 * trigger that had moved from AFTER INSERT to BEFORE UPDATE — three schemas
 * that differ in the ways most likely to matter, all reported as converged.
 * Where PostgreSQL can render an object canonically (pg_get_viewdef,
 * pg_get_functiondef, pg_get_triggerdef) that rendering is what gets compared,
 * because both sides are then produced by the same server code.
 */
const FINGERPRINT_SQL = (schemas: string[]): string => {
  const list = schemas.map(s => `'${s}'`).join(',')
  // Entries are joined with newlines, so any definition that spans lines would
  // otherwise arrive as several unattributed entries — losing the object name
  // and making the sort order depend on the body's formatting.
  const flat = (expr: string) => `btrim(regexp_replace(${expr}, '\\s+', ' ', 'g'))`
  return `
    SELECT string_agg(line, E'\\n' ORDER BY line) AS fp FROM (
      SELECT format('rel %s.%s kind=%s part=%s', n.nspname, c.relname, c.relkind,
                    COALESCE(pg_get_expr(c.relpartbound, c.oid), '-')) AS line
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN (${list}) AND c.relkind IN ('r','p','v','m','S','f')
      UNION ALL
      SELECT format('col %s.%s.%s %s %s %s ident=%s gen=%s store=%s coll=%s',
                    n.nspname, c.relname, a.attname,
                    format_type(a.atttypid, a.atttypmod),
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
                    ${flat(`COALESCE(pg_get_expr(d.adbin, d.adrelid), '-')`)},
                    a.attidentity, a.attgenerated, a.attstorage,
                    COALESCE(co.collname, '-'))
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_collation co ON co.oid = a.attcollation
       WHERE n.nspname IN (${list}) AND a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r','p','v','m')
      UNION ALL
      -- An identity column's sequence options are part of the column: a target
      -- rebuilt without them starts counting from one again.
      SELECT format('seq %s.%s start=%s inc=%s min=%s max=%s cycle=%s',
                    n.nspname, c.relname, s.seqstart, s.seqincrement,
                    s.seqmin, s.seqmax, s.seqcycle)
        FROM pg_sequence s
        JOIN pg_class c ON c.oid = s.seqrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN (${list})
      UNION ALL
      SELECT format('con %s.%s %s', n.nspname, c.conname, ${flat(`pg_get_constraintdef(c.oid)`)})
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname IN (${list})
      UNION ALL
      SELECT format('idx %s.%s %s', schemaname, indexname, indexdef)
        FROM pg_indexes WHERE schemaname IN (${list})
      UNION ALL
      -- The body, not just the signature. prokind is filtered because
      -- pg_get_functiondef errors on aggregate and window functions.
      SELECT format('fn %s.%s(%s) %s', n.nspname, p.proname,
                    pg_get_function_identity_arguments(p.oid),
                    ${flat(`pg_get_functiondef(p.oid)`)})
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN (${list}) AND p.prokind IN ('f','p')
      UNION ALL
      SELECT format('trg %s.%s.%s %s', n.nspname, c.relname, t.tgname,
                    ${flat(`pg_get_triggerdef(t.oid)`)})
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN (${list}) AND NOT t.tgisinternal AND t.tgparentid = 0
      UNION ALL
      -- A view's body is the view. Two views with the same name and columns
      -- but inverted predicates are not the same schema.
      SELECT format('view %s.%s %s', n.nspname, c.relname,
                    ${flat(`pg_get_viewdef(c.oid, true)`)})
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN (${list}) AND c.relkind IN ('v','m')
      UNION ALL
      SELECT format('pol %s.%s.%s cmd=%s roles=%s using=%s check=%s',
                    schemaname, tablename, policyname, cmd,
                    array_to_string(roles, ','),
                    ${flat(`COALESCE(qual, '-')`)}, ${flat(`COALESCE(with_check, '-')`)})
        FROM pg_policies WHERE schemaname IN (${list})
      UNION ALL
      SELECT format('typ %s.%s %s', n.nspname, t.typname,
                    COALESCE((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
                              FROM pg_enum e WHERE e.enumtypid = t.oid), '-'))
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname IN (${list}) AND t.typtype IN ('e','c','d')
    ) t`
}

async function fingerprint(dbUrl: string, schemas: string[]): Promise<string> {
  const rows = await pgQuery(dbUrl, FINGERPRINT_SQL(schemas)) as unknown as Array<{ fp: string | null }>
  return rows[0]?.fp ?? ''
}

/**
 * Prove that `migrationSql` turns the target into the source.
 *
 * Returns `converged: false` with the differing objects rather than throwing,
 * so the caller can decide whether that blocks an apply or merely warns.
 */
export async function proveConvergence(opts: {
  sourceUrl: string
  targetUrl: string
  migrationSql: string
  schemas?: string[]
}): Promise<ProofResult> {
  const schemas = opts.schemas ?? ['public']
  const suffix = randomBytes(4).toString('hex')
  const cloneName = `supaforge_prove_${suffix}`
  const adminUrl = withDatabase(opts.targetUrl, 'postgres')
  const cloneUrl = withDatabase(opts.targetUrl, cloneName)

  let pgDump: string
  let psql: string
  try {
    const major = await getServerMajorVersion(opts.targetUrl)
    const resolved = await resolvePgDumpPath(major)
    if (!resolved) {
      return { converged: false, residual: [], cloneName, skipped: 'pg_dump not available' }
    }
    pgDump = resolved.path
    psql = psqlBeside(pgDump)
  } catch (err) {
    return {
      converged: false, residual: [], cloneName,
      skipped: `could not resolve pg_dump: ${(err as Error).message}`,
    }
  }

  let created = false
  try {
    try {
      await pgQuery(adminUrl, `CREATE DATABASE "${cloneName}"`)
      created = true
    } catch (err) {
      // Typically insufficient privilege. Not being able to prove is not the
      // same as failing to converge, so say which it is.
      return {
        converged: false, residual: [], cloneName,
        skipped: `could not create a throwaway database: ${(err as Error).message}`,
      }
    }

    // Copy the target's structure. Data is irrelevant to a schema proof and
    // copying it would make this unusable on anything but a toy database.
    const dumpArgs = [
      opts.targetUrl, '--schema-only', '--no-owner', '--no-privileges', '--no-comments',
      ...PROOF_EXCLUDED_SCHEMAS.flatMap(s => ['--exclude-schema', s]),
    ]
    const { stdout: structure } = await exec(pgDump, dumpArgs, {
      maxBuffer: 256 * 1024 * 1024, timeout: 300_000,
    })
    await runSql(psql, cloneUrl, structure)

    // The migration under test.
    await runSql(psql, cloneUrl, opts.migrationSql)

    const [want, got] = await Promise.all([
      fingerprint(opts.sourceUrl, schemas),
      fingerprint(cloneUrl, schemas),
    ])

    if (want === got) return { converged: true, residual: [], cloneName }

    const wanted = new Set(want.split('\n').filter(Boolean))
    const actual = new Set(got.split('\n').filter(Boolean))
    const residual = [
      ...[...wanted].filter(l => !actual.has(l)).map(l => `missing: ${l}`),
      ...[...actual].filter(l => !wanted.has(l)).map(l => `unexpected: ${l}`),
    ]
    return { converged: false, residual, cloneName }
  } finally {
    if (created) {
      // Never leave a clone behind, even on failure. Terminating first because
      // a failed apply can leave a session attached.
      await pgQuery(adminUrl,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = '${cloneName}' AND pid <> pg_backend_pid()`).catch(() => undefined)
      await pgQuery(adminUrl, `DROP DATABASE IF EXISTS "${cloneName}"`).catch(() => undefined)
    }
  }
}

/**
 * Execute a multi-statement script through psql rather than a plain connection.
 *
 * pg_dump output is not pure SQL: recent versions emit psql meta-commands such
 * as `\restrict`, which a normal client rejects with a scanner error. psql also
 * gives us ON_ERROR_STOP, so a migration that half-applies fails the proof
 * loudly instead of producing a partially-migrated clone that then reports
 * confusing residual drift.
 */
function runSql(psqlPath: string, dbUrl: string, sql: string): Promise<void> {
  const trimmed = sql.trim()
  if (!trimmed) return Promise.resolve()

  return new Promise((resolve, reject) => {
    // Fed over stdin: promisified execFile has no `input` option, so passing
    // one silently leaves psql waiting on a stdin that never closes until the
    // timeout kills it.
    const child = spawn(psqlPath, [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `psql exited ${code}`))
    })
    child.stdin.write(trimmed)
    child.stdin.end()
  })
}

/** psql ships alongside pg_dump; reuse the version-matched directory. */
function psqlBeside(pgDumpPath: string): string {
  return pgDumpPath === 'pg_dump' ? 'psql' : join(dirname(pgDumpPath), 'psql')
}
