/**
 * A table the source keeps away from the Data API stays that way on the target
 * after one sync.
 *
 * Supabase's default privileges give anon and authenticated everything on a
 * table the moment it is created. A server-only table — `REVOKE ALL ... FROM
 * anon, authenticated`, RLS off — created on the target by the schema fix was
 * therefore readable and writable with the anon key until a second sync took
 * the grants back. Both servers here carry the same defaults Supabase does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

/** What every Supabase database starts with, on both sides. */
const PLATFORM = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
`

const SOURCE = `
  CREATE TABLE public.private_notes (id int PRIMARY KEY, body text);
  REVOKE ALL ON public.private_notes FROM anon, authenticated;
  CREATE TABLE public.ro_items (id int PRIMARY KEY);
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ro_items FROM anon;
  CREATE TABLE public.open_items (id int PRIMARY KEY);
  -- Views are tables to privileges, and get the same defaults.
  CREATE VIEW public.private_v AS SELECT id FROM public.private_notes;
  REVOKE ALL ON public.private_v FROM anon, authenticated;
`

/** Each table's grants to the two API roles, as one comparable line per grant. */
const GRANTS = `
  SELECT coalesce(string_agg(format('%s %s %s', c.relname, a.grantee::regrole, a.privilege_type), E'\\n'
                             ORDER BY c.relname, a.grantee::regrole::text, a.privilege_type), '')
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('private_notes', 'ro_items', 'open_items', 'private_v')
    AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
`

describeE2E('e2e: a new table keeps the source\'s grants', () => {
  let h: PgHarness
  let ws: string

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', PLATFORM + SOURCE)
    await h.applySql('target', PLATFORM)
    ws = await h.workspace()
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('reports, before the sync, what the target\'s defaults would open up', async () => {
    const r = await h.cli(['diff', '--check', 'roles', '--json'], { cwd: ws })
    const scan = JSON.parse(r.stdout) as { checks: Array<{ issues: Array<{ id: string; severity: string }> }> }
    const issues = scan.checks.flatMap(c => c.issues)
    expect(issues.map(i => i.id).sort()).toEqual([
      'roles-grant-default-anon.public.private_notes',
      'roles-grant-default-anon.public.private_v',
      'roles-grant-default-anon.public.ro_items',
      'roles-grant-default-authenticated.public.private_notes',
      'roles-grant-default-authenticated.public.private_v',
    ])
    expect(issues.every(i => i.severity === 'critical')).toBe(true)
  }, 120_000)

  it('leaves every new table with the source\'s grants after one sync', async () => {
    const sync = await h.cli(['diff', '--apply'], { cwd: ws })
    expect(sync.stdout + sync.stderr).not.toMatch(/Rolled back/)
    expect(await h.sql('target', GRANTS)).toBe(await h.sql('source', GRANTS))

    const r = await h.cli(['diff', '--check', 'roles', '--json'], { cwd: ws })
    const scan = JSON.parse(r.stdout) as { checks: Array<{ issues: unknown[] }> }
    expect(scan.checks.flatMap(c => c.issues), r.stdout).toEqual([])
  }, 300_000)
})

describeE2E('e2e: --only a new table keeps the source\'s grants', () => {
  // A selective transfer picking a table's creation (and a function using
  // it) left out the table's "default grants to take back", and the table
  // arrived open to anon.
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', PLATFORM + `
      CREATE TABLE public.t_a (id int PRIMARY KEY, secret text);
      REVOKE ALL ON public.t_a FROM anon, authenticated;
      CREATE FUNCTION public.f_a() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.t_a';
      REVOKE EXECUTE ON FUNCTION public.f_a() FROM PUBLIC, anon, authenticated;
      CREATE TABLE public.t_other (id int PRIMARY KEY);
      REVOKE ALL ON public.t_other FROM anon, authenticated;`)
    await h.applySql('target', PLATFORM)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('takes back the defaults on the table and function it creates, and touches nothing else', async () => {
    const ws = await h.workspace()
    const scan = JSON.parse((await h.cli(['diff', '--json'], { cwd: ws })).stdout) as { checks: Array<{ issues: Array<{ id: string; title: string }> }> }
    const ids = scan.checks.flatMap(c => c.issues)
    const createA = ids.find(i => /Table missing: public\.t_a$/.test(i.title))!.id
    const createF = ids.find(i => /f_a/.test(i.title) && i.id.startsWith('schema-create-function'))!.id

    const r = await h.cli(['diff', '--apply', '--only', createA, '--only', createF], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const anonOnA = `SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = 'public.t_a'::regclass AND a.grantee = 'anon'::regrole`
    expect(await h.sql('target', anonOnA)).toBe('0')
    // The function the source keeps closed arrives closed: a routine is
    // executable by PUBLIC the moment it is created.
    expect(await h.sql('target', "SELECT has_function_privilege('anon', 'public.f_a()', 'EXECUTE')")).toBe('f')
    expect(await h.sql('target', "SELECT count(*) FROM pg_class WHERE relname = 't_other'")).toBe('0')
  }, 300_000)
})
