/**
 * Function and sequence grants are compared, synced and restored.
 *
 * They never were. A SECURITY DEFINER function the source keeps from the Data
 * API — `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, the standard
 * way to keep an elevated function out of reach — became callable with the
 * anon key after a sync or a restore, because PostgreSQL grants EXECUTE to
 * PUBLIC by default and Supabase's default privileges add the API roles. A
 * second sync changed nothing, and nothing reported it. Both servers here
 * carry Supabase's defaults.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const PLATFORM = `
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`
const BOTH = `CREATE FUNCTION public.both_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';`
const SOURCE = BOTH + `
  CREATE FUNCTION public.admin_reset(p int) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS 'SELECT p';
  REVOKE EXECUTE ON FUNCTION public.admin_reset(int) FROM PUBLIC, anon, authenticated;
  REVOKE EXECUTE ON FUNCTION public.both_fn() FROM PUBLIC, anon, authenticated;
  CREATE SEQUENCE public.private_seq;
  REVOKE ALL ON SEQUENCE public.private_seq FROM anon, authenticated;
`

/** Who may run each routine and use each sequence, one comparable line per grant. */
const ACL = `
  SELECT coalesce(string_agg(line, E'\\n' ORDER BY line), '') FROM (
    SELECT format('%s %s %s', p.proname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type) AS line
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.pronamespace = 'public'::regnamespace AND a.grantee <> p.proowner
    UNION ALL
    SELECT format('%s %s %s', c.relname, a.grantee::regrole, a.privilege_type)
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND a.grantee <> c.relowner
  ) x
`

describeE2E('e2e: function and sequence grants', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', PLATFORM + SOURCE)
    await h.applySql('target', PLATFORM + BOTH)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('reports them before the sync, and leaves the target with the source\'s grants after one', async () => {
    const ws = await h.workspace()
    const report = JSON.parse((await h.cli(['diff', '--check', 'roles', '--json'], { cwd: ws })).stdout) as {
      checks: Array<{ issues: Array<{ id: string; severity: string; title: string }> }>
    }
    const titles = report.checks.flatMap(c => c.issues).map(i => `${i.severity} ${i.title}`)
    expect(titles).toEqual(expect.arrayContaining([
      'critical Extra grant: EXECUTE ON function public.both_fn() TO anon',
      'critical Extra grant: EXECUTE ON function public.both_fn() TO PUBLIC',
      'critical Default grants to take back: EXECUTE ON function public.admin_reset(p integer) TO PUBLIC',
      'critical Default grants to take back: EXECUTE ON function public.admin_reset(p integer) TO anon',
    ]))
    expect(titles.some(t => /Default grants to take back: .* ON sequence public\.private_seq TO anon/.test(t))).toBe(true)

    const sync = await h.cli(['diff', '--apply'], { cwd: ws })
    expect(sync.stdout + sync.stderr).not.toMatch(/Rolled back/)
    expect(await h.sql('target', ACL)).toBe(await h.sql('source', ACL))

    const again = JSON.parse((await h.cli(['diff', '--check', 'roles', '--json'], { cwd: ws })).stdout) as {
      checks: Array<{ issues: unknown[] }>
    }
    expect(again.checks.flatMap(c => c.issues)).toEqual([])
  }, 600_000)

  it('restores them exactly from a snapshot', async () => {
    await h.createDatabase('target', 'rg_restored')
    await h.applySqlIn('target', 'rg_restored', PLATFORM)
    const ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') },
        restored: { dbUrl: h.urlFor('target', 'rg_restored') },
      },
    })
    expect((await h.cli(['snapshot', '-e', 'source', '--apply'], { cwd: ws })).code).toBe(0)
    const [snapshot] = await readdir(join(ws, '.supaforge', 'snapshots'))
    const r = await h.cli(['restore', '-e', 'restored', '--from-snapshot', snapshot, '--apply', '--json'], { cwd: ws })
    expect(JSON.parse(r.stdout).errors, r.stdout).toEqual([])
    expect(await h.sqlIn('target', 'rg_restored', ACL)).toBe(await h.sql('source', ACL))
  }, 600_000)
})
