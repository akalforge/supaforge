/**
 * A snapshot of the source restores into the target's server, whatever the
 * pair of versions.
 *
 * Run on every topology the scenario suites run on, so a snapshot of
 * PostgreSQL 17 is restored into 15 here. The grants in it include MAINTAIN,
 * a 17 privilege: grouped into one GRANT with the others, the 15 target
 * rejected the whole statement and the restore rolled back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { scenarioHarness } from './topology.js'

const describeE2E = describeWithContainers()

const ROLES = ['anon', 'authenticated', 'service_role']
  .map(r => `DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`).join('\n')

const SOURCE = `
  CREATE TABLE public.items (id int PRIMARY KEY, owner text, note text);
  GRANT ALL ON public.items TO anon, authenticated, service_role;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.items FROM anon;
  ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own ON public.items FOR SELECT TO authenticated USING (owner = current_user);
  COMMENT ON TABLE public.items IS 'items';
`

/** Grants to the API roles, without MAINTAIN, which a pre-17 server cannot hold. */
const GRANTS = `
  SELECT coalesce(string_agg(format('%s %s', a.grantee::regrole, a.privilege_type), ', '
                             ORDER BY a.grantee::regrole::text, a.privilege_type), '')
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'public.items'::regclass AND a.grantee <> c.relowner AND a.privilege_type <> 'MAINTAIN'
`

describeE2E('scenarios: a snapshot restored across the pair of servers', () => {
  let h: PgHarness
  let ws: string

  beforeAll(async () => {
    h = scenarioHarness()
    await h.up()
    await h.applySql('source', ROLES + SOURCE)
    await h.applySql('target', ROLES)
    await h.createDatabase('target', 'sc_restored')
    ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') },
        restored: { dbUrl: h.urlFor('target', 'sc_restored') },
      },
    })
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('restores the table, its policy, comment and grants', async () => {
    const snap = await h.cli(['snapshot', '-e', 'source', '--apply'], { cwd: ws })
    expect(snap.code, snap.stdout + snap.stderr).toBe(0)
    const [snapshot] = await readdir(join(ws, '.supaforge', 'snapshots'))

    // A 15 target skips MAINTAIN and so reports the restore incomplete (exit
    // 1); nothing may fail or roll back.
    const r = await h.cli(['restore', '-e', 'restored', '--from-snapshot', snapshot, '--apply', '--json'], { cwd: ws })
    const result = JSON.parse(r.stdout) as { errors: unknown[]; rolledBack?: unknown[] }
    expect(result.errors, r.stdout).toEqual([])
    expect(result.rolledBack ?? []).toEqual([])

    const facts = `SELECT obj_description('public.items'::regclass) || ' / ' ||
      (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.items'::regclass)`
    expect(await h.sqlIn('target', 'sc_restored', facts)).toBe('items / 1')
    expect(await h.sqlIn('target', 'sc_restored', GRANTS)).toBe(await h.sql('source', GRANTS))
  }, 600_000)
})
