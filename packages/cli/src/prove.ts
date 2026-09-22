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
  let serverMajor: number
  let clientMajor: number
  try {
    serverMajor = await getServerMajorVersion(opts.targetUrl)
    const resolved = await resolvePgDumpPath(serverMajor)
    if (!resolved) {
      return { converged: false, residual: [], cloneName, skipped: 'pg_dump not available' }
    }
    pgDump = resolved.path
    clientMajor = resolved.major
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

    // pg_dump writes its preamble for its own version, so a newer client can
    // hand an older server a parameter that does not exist there (issue #72).
    const { sql: replayable } = dropUnsupportedSetStatements(
      structure, await knownParameters(cloneUrl),
    )

    try {
      await runSql(psql, cloneUrl, replayable)
    } catch (err) {
      // Rethrown, not returned as `skipped`: a caller treats `skipped` as
      // "could not check, carry on and apply", and this is a case where we do
      // not know what the migration would do. Blocking the apply is the
      // behaviour that was already right (issue #72 confirmed nothing was
      // written and no clone was left behind) — only the message needed to say
      // what the cause actually is.
      throw new Error(
        explainStructureFailure((err as Error).message, clientMajor, serverMajor),
      )
    }

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

/**
 * Lines pg_dump emits before the first real object, in the order it emits them.
 *
 * `\restrict` is a psql meta-command recent versions wrap the script in;
 * `SET` and `SELECT pg_catalog.set_config(...)` configure the session. Nothing
 * here creates anything, which is what makes the preamble safe to rewrite.
 */
const PREAMBLE_LINE =
  /^\s*(?:--|$|\\(?:un)?restrict\b|SET\s+[\w.]+\s*=|SELECT\s+pg_catalog\.set_config\s*\()/i

/** A top-level `SET some.guc = value;`, capturing the parameter name. */
const SET_STATEMENT = /^\s*SET\s+([\w.]+)\s*=/i

/**
 * Drop `SET` statements from a dump's preamble that the destination server
 * would reject.
 *
 * pg_dump writes its preamble for the version of pg_dump, not the version of
 * the server the SQL will be replayed into: pg_dump 17 added an unconditional
 * `SET transaction_timeout = 0;`, and a PostgreSQL 15 or 16 server answers that
 * with `unrecognized configuration parameter`. A PostgreSQL 18 client against a
 * Supabase still on 15 is the common case rather than an exotic one, and it made
 * `--prove` unusable there — it aborted before replaying anything (issue #72).
 *
 * The filter asks the destination which parameters it actually has rather than
 * carrying a list of version-specific names, so the next parameter a future
 * pg_dump adds to the preamble needs no change here.
 *
 * Deliberately narrow in two ways. It only rewrites the leading run of
 * preamble lines, so a `SET` inside a function body — which lives after the
 * first `CREATE` — is never touched. And it only removes statements naming a
 * parameter the destination does not have, so a `SET` that fails for any other
 * reason still fails the proof loudly: `ON_ERROR_STOP` stays on, and no error
 * from the replay is ignored. Tolerating errors instead (as `pg_restore` does,
 * which is why `clone` never noticed this) would let an incomplete clone be
 * reported as converged.
 */
export function dropUnsupportedSetStatements(
  sql: string, knownParameters: ReadonlySet<string>,
): { sql: string; dropped: string[] } {
  const lines = sql.split('\n')
  const dropped: string[] = []
  const kept: string[] = []

  let inPreamble = true
  for (const line of lines) {
    if (inPreamble && !PREAMBLE_LINE.test(line)) inPreamble = false

    if (inPreamble) {
      const name = SET_STATEMENT.exec(line)?.[1]
      if (name && !knownParameters.has(name.toLowerCase())) {
        dropped.push(name.toLowerCase())
        continue
      }
    }
    kept.push(line)
  }

  return { sql: kept.join('\n'), dropped }
}

/** Configuration parameter names this server recognises. */
async function knownParameters(dbUrl: string): Promise<Set<string>> {
  const rows = await pgQuery(dbUrl, 'SELECT name FROM pg_settings') as unknown as
    Array<{ name: string }>
  return new Set(rows.map(r => r.name.toLowerCase()))
}

/**
 * Explain a failure to replay the target's own structure.
 *
 * The raw psql error names a parameter or a syntax element, with nothing to
 * connect it to the real cause — a client newer than the server. Someone
 * reading `unrecognized configuration parameter` goes looking at their schema,
 * which is the one place the problem is not (issue #72).
 */
export function explainStructureFailure(
  message: string, clientMajor: number, serverMajor: number,
): string {
  const versionGap = clientMajor > serverMajor
    ? ` The local client is PostgreSQL ${clientMajor} and the target server is `
      + `${serverMajor}; pg_dump ${clientMajor} can emit SQL that a ${serverMajor} `
      + `server rejects. Installing postgresql-client-${serverMajor} removes the gap.`
    : ''
  return `could not replay the target's structure onto the clone: ${message}${versionGap}`
}
