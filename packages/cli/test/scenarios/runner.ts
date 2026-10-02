/**
 * Drives one migration scenario through the real CLI and judges the outcome by
 * properties every correct run must have, rather than by findings someone
 * listed for one fixture.
 *
 * A scenario is two schemas: the source, which the target must end up as, and
 * the target as it starts. The properties:
 *
 * - **A dry run writes nothing.** The target's state is unchanged.
 * - **An apply never rolls back.** Every fix either applies or is held back
 *   with a reason; none fails.
 * - **With --allow-destructive it converges.** The target's state then equals
 *   the source's, judged by @akalforge/pg-conformance's state query — not by
 *   asking DBDiff, which could only ever agree with its own migration.
 * - **--prove agrees.** When the proof runs, it does not refuse a migration
 *   that converges.
 * - **Rows survive.** The scenario's `preserve` queries return the same rows
 *   on the target before and after it is migrated.
 * - **A second apply finds nothing**, and says so in JSON when asked to. The
 *   diff of the converged pair, by every check, is empty.
 * - **Nothing leaks.** No command touches the servers' roles or databases.
 */
import { diffState } from '../../src/state-diff.js'
import { DEFAULT_IGNORE_SCHEMAS } from '../../src/defaults.js'
import type { PromoteResult } from '../../src/promote.js'
import { isComparisonCheck, type ScanResult } from '../../src/types/drift.js'
import type { PgHarness, CliResult } from '../harness/PgHarness.js'

export interface Scenario {
  /** Unique, and safe in a database name once lowercased. */
  id: string
  /** The schema the target must end up as. */
  source: string
  /** The target as it starts. */
  target: string
  /** Queries whose rows must survive the migration. */
  preserve?: string[]
}

export interface Outcome {
  /** Findings in the first scan. */
  found: number
  /** Fixes the non-destructive apply held back, with their reasons. */
  heldBack: string[]
  /** Differences left between source and target after the destructive apply. */
  residual: string[]
  /** Comparison findings, from every check, in the scan after converging. */
  leftOver: number
  /** The property each failure broke, in words; empty when the scenario passed. */
  violations: string[]
}

const short = (r: CliResult) => (r.stdout + r.stderr).trim().split('\n').slice(-12).join('\n')

/** The JSON a `--json` run printed, which is the whole of its stdout. */
function json<T>(r: CliResult, what: string): T {
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    throw new Error(`${what}: expected JSON (exit ${r.code})\n${short(r)}`)
  }
}

const issueCount = (scan: ScanResult) => scan.checks.reduce((n, c) => n + c.issues.length, 0)

/**
 * Every schema either side holds that SupaForge compares — the same set the
 * scan covers, not just `public`. Judged on `public` alone, a change in any
 * other schema could fail to converge and still pass.
 */
async function userSchemas(h: PgHarness, src: string, tgt: string): Promise<string[]> {
  const sql = `SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
      AND nspname <> ALL (ARRAY[${DEFAULT_IGNORE_SCHEMAS.map(n => `'${n}'`).join(', ')}]::text[])`
  const list = async (role: 'source' | 'target', db: string) => (await h.sqlIn(role, db, sql)).split('\n').filter(Boolean)
  return [...new Set([...await list('source', src), ...await list('target', tgt)])].sort()
}

async function rows(h: PgHarness, role: 'source' | 'target', db: string, queries: string[]): Promise<string[]> {
  return Promise.all(queries.map(q => h.sqlIn(role, db, q)))
}

/**
 * Run one scenario. Databases are named from `key`, so scenarios can run
 * concurrently on the same pair of servers.
 */
export async function runScenario(h: PgHarness, key: string, s: Scenario): Promise<Outcome> {
  const src = `sc_${key}_s`
  const tgt = `sc_${key}_t`
  const violations: string[] = []
  const outcome: Outcome = { found: 0, heldBack: [], residual: [], leftOver: 0, violations }

  await Promise.all([h.createDatabase('source', src), h.createDatabase('target', tgt)])
  try {
    await Promise.all([h.applySqlIn('source', src, s.source), h.applySqlIn('target', tgt, s.target)])

    const ws = await h.workspace({
      environments: {
        source: { dbUrl: h.urlFor('source', src) },
        target: { dbUrl: h.urlFor('target', tgt) },
      },
    })
    const cli = (...args: string[]) => h.cli(['diff', '--check=schema', ...args], { cwd: ws })
    const preserve = s.preserve ?? []
    const rowsBefore = await rows(h, 'target', tgt, preserve)

    // The plan, and a dry run of it, change nothing.
    const schemas = await userSchemas(h, src, tgt)
    const scan = await cli('--json')
    outcome.found = issueCount(json<ScanResult>(scan, 'first scan'))
    const before = await h.stateIn('target', tgt, schemas)
    const dry = await cli('--dry-run', '--json')
    json<PromoteResult>(dry, 'dry run')
    if (diffState(before, await h.stateIn('target', tgt, schemas)).length > 0) {
      violations.push('a dry run changed the target')
    }

    // Applied as a user would first: drops held back, nothing rolled back.
    const safe = await cli('--apply', '--json')
    const safeResult = json<PromoteResult>(safe, 'apply')
    outcome.heldBack = safeResult.skipped.map(k => `${k.issueId}: ${k.reason}`)
    if (safeResult.rolledBack?.length) {
      violations.push(`the apply rolled back: ${safeResult.errors.map(e => e.error).join('; ')}`)
    }

    // Then everything, proved first. The proof needs a pg_dump at least as
    // new as the server; where there is none it says so and steps aside.
    const all = await cli('--apply', '--allow-destructive', '--prove')
    const allOut = all.stdout + all.stderr
    if (/does not reproduce the source/.test(allOut)) violations.push(`--prove refused the migration:\n${short(all)}`)
    if (/Rolled back/.test(allOut)) violations.push(`the destructive apply rolled back:\n${short(all)}`)
    // CI installs a pg_dump for every server, so there a proof that cannot
    // find one is a broken job, not a reason to pass having proved nothing.
    if (process.env.SCENARIO_REQUIRE_PROOF && /Convergence not proven: (pg_dump|could not resolve pg_dump)/.test(allOut)) {
      violations.push(`--prove did not run:\n${short(all)}`)
    }

    outcome.residual = diffState(await h.stateIn('source', src, schemas), await h.stateIn('target', tgt, schemas))
    if (outcome.residual.length > 0) {
      violations.push(`the target does not match the source:\n  ${outcome.residual.join('\n  ')}`)
    }

    const rowsAfter = await rows(h, 'target', tgt, preserve)
    preserve.forEach((q, i) => {
      if (rowsAfter[i] !== rowsBefore[i]) violations.push(`rows changed for ${q}:\n  before: ${rowsBefore[i]}\n  after:  ${rowsAfter[i]}`)
    })

    // Applying again does nothing, and --json still means JSON when there is
    // nothing to do — that branch once printed a sentence instead.
    if (outcome.residual.length === 0) {
      const second = json<PromoteResult>(await cli('--apply', '--json'), 'second apply')
      if (second.applied.length > 0) {
        violations.push(`a second apply applied ${second.applied.map(a => a.issueId).join(', ')}`)
      }
    }

    // Every check this time, not just the schema: a converged pair must look
    // identical to all of them.
    const again = json<ScanResult>(await h.cli(['diff', '--json'], { cwd: ws }), 'second scan')
    const left = again.checks.filter(c => isComparisonCheck(c.check)).flatMap(c => c.issues.map(i => `${c.check}: ${i.title}`))
    outcome.leftOver = left.length
    if (left.length > 0 && outcome.residual.length === 0) {
      violations.push(`the converged pair still reports:\n  ${left.join('\n  ')}`)
    }
  } finally {
    await Promise.all([h.dropDatabase('source', src), h.dropDatabase('target', tgt)])
  }
  return outcome
}

/**
 * Every comparison finding for a pair, across all checks rather than only the
 * schema: two databases holding the same schema must produce none, whichever
 * check is looking. Posture checks are left out; they report on the target
 * alone, not on a difference.
 */
export async function comparisonFindings(h: PgHarness, key: string, source: string, target: string): Promise<string[]> {
  const src = `sc_${key}_s`
  const tgt = `sc_${key}_t`
  await Promise.all([h.createDatabase('source', src), h.createDatabase('target', tgt)])
  try {
    await Promise.all([h.applySqlIn('source', src, source), h.applySqlIn('target', tgt, target)])
    const ws = await h.workspace({
      environments: {
        source: { dbUrl: h.urlFor('source', src) },
        target: { dbUrl: h.urlFor('target', tgt) },
      },
    })
    const scan = json<ScanResult>(await h.cli(['diff', '--json'], { cwd: ws }), 'scan')
    return scan.checks
      .filter(c => isComparisonCheck(c.check))
      .flatMap(c => [...c.issues.map(i => `${c.check}: ${i.title}`), ...(c.status === 'error' ? [`${c.check}: error ${c.error}`] : [])])
  } finally {
    await Promise.all([h.dropDatabase('source', src), h.dropDatabase('target', tgt)])
  }
}
