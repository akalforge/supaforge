/**
 * The four reported bugs (#66, #70, #71, #72), through the real command.
 *
 * Each is a property of the CLI's wiring rather than of a function: which exit
 * code the process returns, what it writes to stderr, whether a flag reaches the
 * planner, how a title reads once dbdiff has produced the SQL. Unit tests cover
 * the pieces; this covers that they are connected.
 *
 * Two scratch databases on the source server with deliberate drift between them,
 * so the assertions are about real @dbdiff/cli output rather than fixtures.
 * Skipped unless SUPAFORGE_TEST_SOURCE_URL is set, matching the convention in
 * cli.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import pg from 'pg'

const exec = promisify(execFile)
// test/e2e/ → packages/cli/
const CLI_DIR = join(import.meta.dirname, '..', '..')
const DEV_BIN = join(CLI_DIR, 'bin', 'dev.js')
const TSX_BIN = join(CLI_DIR, 'node_modules', '.bin', 'tsx')

const DB_SOURCE = process.env.SUPAFORGE_TEST_SOURCE_URL
const skipNoDb = !DB_SOURCE

function replaceDbName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

describe('CLI e2e: reported bugs', () => {
  let tmpDir: string
  const stamp = Date.now()
  const SRC_DB = `sf_bugs_src_${stamp}`
  const TGT_DB = `sf_bugs_tgt_${stamp}`

  const SEED_SOURCE = `
    CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL);
    CREATE TABLE orders (id serial PRIMARY KEY, status text DEFAULT 'pending');
    CREATE INDEX idx_orders_status ON orders(status);
    CREATE FUNCTION touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE VIEW active_orders AS SELECT * FROM orders WHERE status = 'pending';
    CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION touch_updated();
  `
  const SEED_TARGET = `
    CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL);
    CREATE TABLE orders (id serial PRIMARY KEY);
    CREATE TABLE legacy_notes (id serial PRIMARY KEY, body text);
    CREATE FUNCTION example_fn(a uuid, b integer) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;
  `

  /** NO_COLOR keeps the output free of escape sequences, so assertions read plainly. */
  function run(args: string[]) {
    return exec(TSX_BIN, [DEV_BIN, ...args], {
      cwd: tmpDir,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 120_000,
    })
  }

  /** Run without exec() throwing, so the exit code itself can be asserted. */
  async function runExit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run(args)
      return { code: 0, stdout, stderr }
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string }
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }

  async function onAdmin(fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const admin = new pg.Client({ connectionString: replaceDbName(DB_SOURCE!, 'postgres') })
    await admin.connect()
    try { await fn(admin) } finally { await admin.end() }
  }

  async function onDb(dbName: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
    const c = new pg.Client({ connectionString: replaceDbName(DB_SOURCE!, dbName) })
    await c.connect()
    try { await fn(c) } finally { await c.end() }
  }

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `supaforge-e2e-bugs-${stamp}`)
    await mkdir(tmpDir, { recursive: true })
    if (skipNoDb) return

    await onAdmin(async (admin) => {
      await admin.query(`CREATE DATABASE "${SRC_DB}"`)
      await admin.query(`CREATE DATABASE "${TGT_DB}"`)
    })
    await onDb(SRC_DB, c => c.query(SEED_SOURCE).then(() => undefined))
    await onDb(TGT_DB, c => c.query(SEED_TARGET).then(() => undefined))

    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify({
      environments: {
        src: { dbUrl: replaceDbName(DB_SOURCE!, SRC_DB) },
        tgt: { dbUrl: replaceDbName(DB_SOURCE!, TGT_DB) },
      },
      source: 'src',
      target: 'tgt',
      checks: { exclude: ['storage', 'auth', 'edge-functions', 'vault', 'realtime', 'data'] },
    }, null, 2))
  }, 120_000)

  afterAll(async () => {
    if (!skipNoDb) {
      await onAdmin(async (admin) => {
        for (const db of [SRC_DB, TGT_DB]) {
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = '${db}' AND pid <> pg_backend_pid()`).catch(() => undefined)
          await admin.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => undefined)
        }
      })
    }
    await rm(tmpDir, { recursive: true, force: true })
  }, 120_000)

  // ── #66: the exit code could not distinguish drift from posture ────────────

  it.skipIf(skipNoDb)('exits 0 when the environments agree and only the target has findings', async () => {
    // No RLS anywhere, so RLS Coverage reports every table as critical while
    // every comparison check is clean — the combination that used to exit 1.
    const { code, stdout } = await runExit(['diff', '--skip=schema', '--skip=migrations'])
    expect(stdout).toContain('no drift detected')
    expect(stdout).toContain('CRITICAL')
    expect(code).toBe(0)
  }, 180_000)

  it.skipIf(skipNoDb)('says why the exit code ignored them', async () => {
    const { stdout } = await runExit(['diff', '--skip=schema', '--skip=migrations'])
    expect(stdout).toContain('--fail-on-posture')
  }, 180_000)

  it.skipIf(skipNoDb)('exits 1 on those same findings when asked to', async () => {
    const { code } = await runExit(['diff', '--skip=schema', '--skip=migrations', '--fail-on-posture'])
    expect(code).toBe(1)
  }, 180_000)

  it.skipIf(skipNoDb)('still exits 1 on real drift', async () => {
    const { code } = await runExit(['diff', '--check=schema'])
    expect(code).toBe(1)
  }, 180_000)

  it.skipIf(skipNoDb)('--ci carries the same distinction, and still reports the findings', async () => {
    const posture = await runExit(['diff', '--ci', '--skip=schema', '--skip=migrations'])
    expect(posture.code).toBe(0)
    const report = JSON.parse(posture.stdout) as {
      score: number
      criticalIssues: unknown[]
    }
    expect(report.criticalIssues.length).toBeGreaterThan(0)
    expect(report.score).toBe(100)

    const gated = await runExit(['diff', '--ci', '--skip=schema', '--skip=migrations', '--fail-on-posture'])
    expect(gated.code).toBe(1)
  }, 180_000)

  // ── #70: titles were qualified for some object types and not others ────────

  it.skipIf(skipNoDb)('titles every schema finding as <finding>: schema.name', async () => {
    const { stdout } = await runExit(['diff', '--check=schema', '--detail'])

    // Issue lines only: `✖ [CRITICAL] Extra table: public.legacy_notes`. The
    // per-layer summary lines carry the severity as a trailing suffix
    // (`8 issues[CRITICAL]`) and are not titles.
    const titles = stdout.split('\n')
      .map(l => /\[(?:CRITICAL|WARNING|INFO)\]\s+(\S.*: .+)$/.exec(l.trim())?.[1])
      .filter((t): t is string => Boolean(t))

    // The seed produces findings across tables, views, triggers, indexes and
    // functions — the exact set that used to disagree.
    expect(titles.length).toBeGreaterThan(4)
    for (const title of titles) {
      const name = title.slice(title.indexOf(': ') + 2)
      const head = name.includes('(') ? name.slice(0, name.indexOf('(')) : name
      expect(head, `unqualified title: ${title}`).toContain('public.')
    }
  }, 180_000)

  it.skipIf(skipNoDb)('recommends skipping roles alongside the other clone-only layers', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('--skip=roles')
  }, 60_000)

  // ── #71: apply-only flags were inert and silent ────────────────────────────

  it.skipIf(skipNoDb)('--dry-run alone prints the plan and writes nothing', async () => {
    const { code, stdout } = await runExit(['diff', '--check=schema', '--dry-run'])
    expect(stdout).toMatch(/Would apply \d+ fix\(es\), in this order/)
    expect(stdout).toContain('Nothing was executed')
    expect(code).toBe(0)

    // The target must be untouched: the column the fix set would add is absent.
    await onDb(TGT_DB, async (c) => {
      const { rows } = await c.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'status'`)
      expect(rows).toHaveLength(0)
    })
  }, 180_000)

  it.skipIf(skipNoDb)('warns that an apply-only flag did nothing, on stderr', async () => {
    const { stdout, stderr } = await runExit(['diff', '--check=schema', '--prove'])
    expect(stderr).toContain('--prove has no effect without --apply')
    expect(stdout).not.toContain('has no effect')
  }, 180_000)

  it.skipIf(skipNoDb)('keeps stdout parseable under --json while warning on stderr', async () => {
    const { stdout, stderr } = await runExit(['diff', '--check=schema', '--json', '--only=schema-alter-1'])
    expect(stderr).toContain('--only has no effect without --apply')
    expect(() => JSON.parse(stdout) as unknown).not.toThrow()
  }, 180_000)

  it.skipIf(skipNoDb)('--dry-run honours the flags that shape the plan, without warning', async () => {
    const all = await runExit(['diff', '--check=schema', '--dry-run'])
    const one = await runExit(['diff', '--check=schema', '--dry-run', '--only=schema-create-index-*'])

    const count = (out: string) => Number(/Would apply (\d+) fix/.exec(out)?.[1] ?? '0')
    expect(count(one.stdout)).toBe(1)
    expect(count(all.stdout)).toBeGreaterThan(1)
    expect(one.stderr).not.toContain('--only has no effect')
  }, 180_000)

  // ── #71.2: the advice ignored which way the diff ran ──────────────────────

  it.skipIf(skipNoDb)('warns instead of recommending --apply when the source looks like a clone', async () => {
    const before = await runExit(['diff', '--check=schema'])
    expect(before.stdout).toContain('Run with --apply to fix drift')

    // Make the target Supabase-shaped while the source stays vanilla: pushing
    // the source onto it would drop everything Supabase put there.
    await onDb(TGT_DB, async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS auth')
      await c.query('CREATE SCHEMA IF NOT EXISTS storage')
    })

    try {
      const after = await runExit(['diff', '--check=schema'])
      expect(after.stdout).not.toContain('Run with --apply to fix drift')
      expect(after.stdout).toContain('absences included')
    } finally {
      await onDb(TGT_DB, async (c) => {
        await c.query('DROP SCHEMA IF EXISTS auth CASCADE')
        await c.query('DROP SCHEMA IF EXISTS storage CASCADE')
      })
    }
  }, 180_000)
})
