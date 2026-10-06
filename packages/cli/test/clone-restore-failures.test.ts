import { describe, it, expect } from 'vitest'
import { restoreFailures } from '../src/branch.js'
import { formatRestoreFailures, formatUnavailable } from '../src/commands/clone.js'

/**
 * pg_restore exits 1 and carries on when statements fail. The clone read that
 * as success, so a table typed by an extension the local server lacks was not
 * in the clone, and nothing said so. This is pg_restore's own output for such
 * a clone: pgvector unavailable, `extensions` not created, two tables lost.
 */
const STDERR = `pg_restore: error: could not execute query: ERROR:  schema "public" already exists
Command was: CREATE SCHEMA public;


pg_restore: error: could not execute query: ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file "/usr/share/postgresql/17/extension/vector.control": No such file or directory.
HINT:  The extension must first be installed on the system where PostgreSQL is running.
Command was: CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;


pg_restore: error: could not execute query: ERROR:  extension "vector" does not exist
Command was: COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


pg_restore: error: could not execute query: ERROR:  schema "extensions" does not exist
LINE 4:     embedding extensions.vector(3)
                      ^
Command was: CREATE TABLE public.docs (
    id integer NOT NULL,
    title text,
    embedding extensions.vector(3)
);


pg_restore: error: could not execute query: ERROR:  relation "public.docs" does not exist
Command was: COPY public.docs (id, title, embedding) FROM stdin;
pg_restore: error: could not execute query: ERROR:  relation "public.docs" does not exist
Command was: ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_pkey PRIMARY KEY (id);


pg_restore: warning: errors ignored on restore: 6
`

describe('restoreFailures', () => {
  it('lists each object of the project that is not in the clone, with its error', () => {
    expect(restoreFailures(STDERR).failures).toEqual([
      { object: 'CREATE TABLE public.docs', error: 'schema "extensions" does not exist' },
      { object: 'data for public.docs', error: 'relation "public.docs" does not exist' },
      { object: 'ALTER TABLE ONLY public.docs', error: 'relation "public.docs" does not exist' },
    ])
  })

  it('leaves out what already exists, and the comment on a missing extension', () => {
    const objects = restoreFailures(STDERR).failures.map(f => f.object)

    expect(objects).not.toContain('CREATE SCHEMA public')
    expect(objects.some(o => o.startsWith('COMMENT ON EXTENSION'))).toBe(false)
  })

  it('keeps the comment on an extension that is not itself reported', () => {
    const stderr = `pg_restore: error: could not execute query: ERROR:  extension "pg_trgm" does not exist
Command was: COMMENT ON EXTENSION pg_trgm IS 'text similarity';
`
    expect(restoreFailures(stderr).failures).toHaveLength(1)
  })

  it('is empty for a clean restore', () => {
    expect(restoreFailures('')).toEqual({ failures: [], unavailable: [] })
  })
})

/**
 * Every Supabase project has extensions plain PostgreSQL does not ship, and
 * event triggers granting access to them. Counted as failures, they made every
 * clone of a Supabase project "incomplete" and exit 1.
 */
describe('restoreFailures: what this server cannot have', () => {
  const SUPABASE = `pg_restore: error: could not execute query: ERROR:  extension "pg_net" is not available
Command was: CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


pg_restore: error: could not execute query: ERROR:  function extensions.grant_pg_net_access() does not exist
Command was: CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_net_access();


`

  it('sets apart an extension the server does not ship, and the platform\'s event triggers', () => {
    const { failures, unavailable } = restoreFailures(SUPABASE)

    expect(failures).toEqual([])
    expect(unavailable.map(u => u.object)).toEqual([
      'extension pg_net',
      'CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end',
    ])
  })

  it('still fails what of the project needed the missing extension', () => {
    // pgvector unavailable is context; the table typed by it being lost is not.
    const { failures, unavailable } = restoreFailures(STDERR)

    expect(unavailable.map(u => u.object)).toEqual(['extension vector'])
    expect(failures.map(f => f.object)).toContain('CREATE TABLE public.docs')
  })

  it('keeps an event trigger of the project\'s that failed for another reason', () => {
    const stderr = `pg_restore: error: could not execute query: ERROR:  function public.audit_ddl() does not exist
Command was: CREATE EVENT TRIGGER audit ON ddl_command_end EXECUTE FUNCTION public.audit_ddl();
`
    expect(restoreFailures(stderr).failures).toHaveLength(1)
  })
})

describe('formatUnavailable', () => {
  it('says nothing when everything was available', () => {
    expect(formatUnavailable([])).toEqual([])
  })

  it('names the extensions and counts the event triggers, on one line', () => {
    const lines = formatUnavailable([
      { object: 'extension pg_net', error: 'x' },
      { object: 'extension pgjwt', error: 'x' },
      { object: 'CREATE EVENT TRIGGER t ON ddl_command_end', error: 'x' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('extensions pg_net, pgjwt')
    expect(lines[0]).toContain('1 event trigger(s)')
  })
})

describe('formatRestoreFailures', () => {
  it('says nothing when nothing failed', () => {
    expect(formatRestoreFailures([])).toEqual([])
  })

  it('names each object, and stops at fifteen', () => {
    const many = Array.from({ length: 18 }, (_, i) => ({ object: `CREATE TABLE public.t${i}`, error: 'x' }))
    const lines = formatRestoreFailures(many)

    expect(lines[0]).toContain('18 statement(s) failed')
    expect(lines.filter(l => l.includes('CREATE TABLE'))).toHaveLength(15)
    expect(lines.at(-1)).toContain('…and 3 more')
  })
})

describe('restoreFailures: a newer pg_dump', () => {
  // pg_dump 17+ writes SET transaction_timeout = 0; a 15 server rejects it,
  // and every clone into one read as incomplete for it.
  it('does not count a newer pg_dump\'s session setting as something missing', () => {
    const stderr = [
      'pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"',
      'Command was: SET transaction_timeout = 0;',
      '',
    ].join('\n')
    expect(restoreFailures(stderr)).toEqual({ failures: [], unavailable: [] })
  })
})

