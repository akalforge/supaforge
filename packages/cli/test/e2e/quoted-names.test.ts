/**
 * Names with double quotes in them survive a sync and a restore.
 *
 * A policy named `say "hi" there` was written between plain quotes, a syntax
 * error: the restore holding it rolled back entirely, and `diff --apply`
 * applied nothing from that run, unrelated fixes included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const ROLE = `DO $$ BEGIN CREATE ROLE "Admins ""A""" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
const TABLE = `CREATE TABLE public."Odd ""table""" (id int PRIMARY KEY);
  ALTER TABLE public."Odd ""table""" ENABLE ROW LEVEL SECURITY;`
const POLICIES = `
  CREATE POLICY "say ""hi"" there" ON public."Odd ""table""" FOR SELECT TO "Admins ""A""", authenticated USING (true);
  COMMENT ON POLICY "say ""hi"" there" ON public."Odd ""table""" IS 'a "quoted" note';
`
const PLATFORM = `DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`

/** The policy as the catalog has it: name, roles and comment. */
const POLICY = `
  SELECT format('%s | %s | %s', p.polname,
                (SELECT string_agg(r::regrole::text, ',' ORDER BY r::regrole::text) FROM unnest(p.polroles) r),
                obj_description(p.oid, 'pg_policy'))
  FROM pg_policy p WHERE p.polrelid = to_regclass('public."Odd ""table"""')
`
const EXPECTED = `say "hi" there | "Admins ""A""",authenticated | a "quoted" note`

describeE2E('e2e: names with double quotes in them', () => {
  let h: PgHarness
  let ws: string

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', PLATFORM + ROLE + TABLE + POLICIES)
    await h.applySql('target', PLATFORM + ROLE + TABLE)
    await h.createDatabase('target', 'sf_quoted_restore')
    ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') },
        target: { dbUrl: h.connectionString('target') },
        restored: { dbUrl: h.urlFor('target', 'sf_quoted_restore') },
      },
    })
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  // The RLS check's own SQL. The schema check's comes from @dbdiff/cli, and
  // the pg-conformance case quoted_identifiers covers it in the scenarios.
  it('syncs the policy and its roles', async () => {
    const sync = await h.cli(['diff', '--check', 'rls', '--apply'], { cwd: ws })
    expect(sync.stdout + sync.stderr).not.toMatch(/Rolled back|syntax error/)
    expect(await h.sql('target', POLICY)).toBe(EXPECTED.replace(/ \| [^|]*$/, ' |'))
  }, 300_000)

  it('restores it from a snapshot', async () => {
    const snap = await h.cli(['snapshot', '-e', 'source', '--apply'], { cwd: ws })
    expect(snap.code, snap.stdout + snap.stderr).toBe(0)
    const [snapshot] = await readdir(join(ws, '.supaforge', 'snapshots'))
    const restore = await h.cli(['restore', '-e', 'restored', '--from-snapshot', snapshot, '--apply'], { cwd: ws })
    expect(restore.stdout + restore.stderr).not.toMatch(/Rolled back|syntax error/)
    expect(await h.sqlIn('target', 'sf_quoted_restore', POLICY)).toBe(EXPECTED)
  }, 300_000)
})
