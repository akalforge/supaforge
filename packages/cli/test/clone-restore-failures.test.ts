import { describe, it, expect } from 'vitest'
import { restoreFailures } from '../src/branch.js'
import { formatRestoreFailures } from '../src/commands/clone.js'

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
  it('lists each statement pg_restore could not run, with its error', () => {
    expect(restoreFailures(STDERR)).toEqual([
      { object: 'extension vector', error: 'extension "vector" is not available' },
      { object: 'CREATE TABLE public.docs', error: 'schema "extensions" does not exist' },
      { object: 'data for public.docs', error: 'relation "public.docs" does not exist' },
      { object: 'ALTER TABLE ONLY public.docs', error: 'relation "public.docs" does not exist' },
    ])
  })

  it('leaves out what already exists, and the comment on a missing extension', () => {
    const objects = restoreFailures(STDERR).map(f => f.object)

    expect(objects).not.toContain('CREATE SCHEMA public')
    expect(objects.some(o => o.startsWith('COMMENT ON EXTENSION'))).toBe(false)
  })

  it('keeps the comment on an extension that is not itself reported', () => {
    const stderr = `pg_restore: error: could not execute query: ERROR:  extension "pg_trgm" does not exist
Command was: COMMENT ON EXTENSION pg_trgm IS 'text similarity';
`
    expect(restoreFailures(stderr)).toHaveLength(1)
  })

  it('is empty for a clean restore', () => {
    expect(restoreFailures('')).toEqual([])
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
