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
import { fingerprintSql, stateSql, type SchemaState } from '@akalforge/pg-conformance'
import { pgQuery } from './db'
import { diffState } from './state-diff'
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
 * The structural fingerprint comes from @akalforge/pg-conformance.
 *
 * It used to be defined here, and separately in the e2e harness, and again in
 * dbdiff's conformance runner. They drifted, and this copy was the one that
 * compared views, functions and triggers by name alone — so it called two
 * schemas converged when a view's predicate had been inverted, a function's
 * body replaced, or a trigger moved from AFTER INSERT to BEFORE UPDATE.
 *
 * A shared definition of "same schema" is the whole point of the proof, so it
 * lives in one place that both projects depend on.
 */

async function fingerprint(dbUrl: string, schemas: string[]): Promise<string> {
  const rows = await pgQuery(dbUrl, fingerprintSql(schemas)) as unknown as
    Array<{ fingerprint: string | null }>

  // An empty fingerprint would make every comparison succeed, so a schema that
  // produced nothing is treated as a fault rather than as "no differences".
  // Reading the wrong column name would fail exactly this way, silently.
  const value = rows[0]?.fingerprint
  if (value === undefined) {
    throw new Error('fingerprint query returned no "fingerprint" column')
  }
  return value ?? ''
}

/**
 * Say what differs, in terms a reader can act on.
 *
 * The fingerprint has already decided that something does. This turns the two
 * schema-state documents into named findings — "column public.orders.total:
 * storage extended → plain" — rather than two near-identical lines of catalog
 * shorthand with one field moved somewhere in the middle.
 *
 * Falls back to the raw fingerprint lines if the structured diff comes back
 * empty. That should not happen, but "the schemas differ and I cannot tell you
 * how" is a far worse answer than an ugly one.
 */
async function describeDifference(
  sourceUrl: string, cloneUrl: string, schemas: string[], want: string, got: string,
): Promise<string[]> {
  try {
    const [before, after] = await Promise.all([
      schemaState(sourceUrl, schemas),
      schemaState(cloneUrl, schemas),
    ])
    const findings = diffState(before, after)
    if (findings.length > 0) return findings
  } catch {
    // fall through to the fingerprint lines
  }

  const wanted = new Set(want.split('\n').filter(Boolean))
  const actual = new Set(got.split('\n').filter(Boolean))
  return [
    ...[...wanted].filter(l => !actual.has(l)).map(l => `missing: ${l}`),
    ...[...actual].filter(l => !wanted.has(l)).map(l => `unexpected: ${l}`),
  ]
}

/** The schema-state document for one database. */
async function schemaState(dbUrl: string, schemas: string[]): Promise<SchemaState> {
  const rows = await pgQuery(dbUrl, stateSql(schemas)) as unknown as Array<{ state: string | null }>
  const value = rows[0]?.state
  if (!value) throw new Error('state query returned no "state" column')
  return JSON.parse(value) as SchemaState
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
      opts.targetUrl, '--schema-only', '--no-owner', '--no-privileges',
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

    // The verdict stays with the fingerprint. It is the comparison already
    // trusted, and keeping it means the structured diff below can only change
    // how a difference is *described*, never whether one is detected.
    if (want === got) return { converged: true, residual: [], cloneName }

    return {
      converged: false,
      residual: await describeDifference(opts.sourceUrl, cloneUrl, schemas, want, got),
      cloneName,
    }
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
