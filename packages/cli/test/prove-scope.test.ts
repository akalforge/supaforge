import { describe, it, expect } from 'vitest'
import { proofScope } from '../src/prove.js'

const fix = (check: string, sql: string) => ({ check, issueId: `${check}-x`, sql })
const ids = (xs: Array<{ sql: string }>) => xs.map(x => x.sql)

/**
 * What `--prove` replays on its throwaway database.
 *
 * Everything planned used to be replayed there. `cron.schedule()` failed,
 * since pg_cron lives in one database per server, and aborted the proof; and
 * `CREATE ROLE` succeeded, which is worse — a role is the server's, so the
 * proof created it for real and the apply's own CREATE ROLE then failed.
 */
describe('proofScope', () => {
  it('replays the fixes the fingerprint covers', () => {
    const planned = [
      fix('schema', 'CREATE TABLE public.t (id int);'),
      fix('rls', 'CREATE POLICY p ON public.t USING (true);'),
      fix('rls-coverage', 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;'),
      fix('extensions', 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'),
    ]
    expect(proofScope(planned)).toEqual({ replay: planned, unproved: [] })
  })

  it('does not replay cron, roles, publications or reference data', () => {
    const planned = [
      fix('schema', 'CREATE TABLE public.t (id int);'),
      fix('cron', "SELECT cron.schedule('nightly', '0 3 * * *', $$SELECT 1$$);"),
      fix('roles', 'CREATE ROLE "reporting" NOLOGIN;'),
      fix('roles', 'GRANT SELECT ON "public"."t" TO "reporting";'),
      fix('realtime', 'ALTER PUBLICATION supabase_realtime ADD TABLE public.t;'),
      fix('data', "INSERT INTO public.plans (id) VALUES (1);"),
    ]
    const { replay, unproved } = proofScope(planned)

    expect(ids(replay)).toEqual(['CREATE TABLE public.t (id int);'])
    expect(unproved.map(u => u.check)).toEqual(['cron', 'roles', 'roles', 'realtime', 'data'])
  })

  it('never replays a server-wide statement, whatever check planned it', () => {
    const planned = [
      fix('schema', 'CREATE ROLE app NOLOGIN;\nCREATE TABLE public.t (id int);'),
      fix('schema', 'GRANT reporting TO app;'),
      fix('schema', 'ALTER SYSTEM SET work_mem = 1;'),
      fix('schema', 'DROP DATABASE other;'),
      fix('schema', 'GRANT SELECT ON public.t TO app;'),
    ]
    const { replay, unproved } = proofScope(planned)

    // A table grant stays: it is the database's. Role membership does not.
    expect(ids(replay)).toEqual(['GRANT SELECT ON public.t TO app;'])
    expect(unproved).toHaveLength(4)
  })

  it('does not take a role named inside a function body for a server-wide statement', () => {
    const body = `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'CREATE ROLE x'; END $$;`
    expect(ids(proofScope([fix('schema', body)]).replay)).toEqual([body])
  })
})
