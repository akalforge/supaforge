import { describe, it, expect } from 'vitest'
import { dropUnsupportedSetStatements, explainStructureFailure } from '../src/prove.js'

/**
 * The real preamble `pg_dump` 18.6 writes when dumping a PostgreSQL 15 server,
 * captured verbatim from a live run rather than hand-written — the point of the
 * test is that the *actual* output is handled, and the line that breaks a 15
 * server (`SET transaction_timeout = 0;`) only appears because pg_dump writes
 * its preamble for its own version.
 */
const PG18_PREAMBLE_ON_PG15 = `--
-- PostgreSQL database dump
--

\\restrict 2imZAWoucebPdNjsNGAABYXJ7ydb6QezfXinEcPqwxeUYTtgsalzYJNIJHczm48

-- Dumped from database version 15.19 (Debian 15.19-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    total numeric(10,2)
);
`

/** What a PostgreSQL 15 server actually recognises, for the names in play. */
const PG15_PARAMETERS = new Set([
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
  'client_encoding', 'standard_conforming_strings', 'check_function_bodies',
  'xmloption', 'client_min_messages', 'row_security', 'search_path',
])

describe('dropUnsupportedSetStatements (issue #72)', () => {
  it('removes the parameter a PostgreSQL 15 server does not have', () => {
    const { sql, dropped } = dropUnsupportedSetStatements(PG18_PREAMBLE_ON_PG15, PG15_PARAMETERS)
    expect(dropped).toEqual(['transaction_timeout'])
    expect(sql).not.toContain('transaction_timeout')
  })

  it('keeps every parameter the server does have', () => {
    const { sql } = dropUnsupportedSetStatements(PG18_PREAMBLE_ON_PG15, PG15_PARAMETERS)
    for (const kept of [
      'SET statement_timeout = 0;',
      'SET lock_timeout = 0;',
      'SET idle_in_transaction_session_timeout = 0;',
      "SET client_encoding = 'UTF8';",
      'SET row_security = off;',
    ]) {
      expect(sql).toContain(kept)
    }
  })

  it('leaves the schema itself untouched', () => {
    const { sql } = dropUnsupportedSetStatements(PG18_PREAMBLE_ON_PG15, PG15_PARAMETERS)
    expect(sql).toContain('CREATE TABLE public.orders (')
    expect(sql).toContain('total numeric(10,2)')
    // The psql meta-command recent pg_dumps wrap the script in must survive:
    // dropping it would unbalance \restrict / \unrestrict.
    expect(sql).toContain('\\restrict')
  })

  it('changes nothing when the client and server agree', () => {
    const all = new Set([...PG15_PARAMETERS, 'transaction_timeout'])
    const { sql, dropped } = dropUnsupportedSetStatements(PG18_PREAMBLE_ON_PG15, all)
    expect(dropped).toEqual([])
    expect(sql).toBe(PG18_PREAMBLE_ON_PG15)
  })

  /**
   * The filter must not reach into object bodies. A function that legitimately
   * contains a `SET` line would otherwise be silently rewritten, which would
   * make the clone differ from the target and the proof's verdict meaningless.
   */
  it('never touches a SET inside a function body', () => {
    const dump = [
      'SET transaction_timeout = 0;',
      '',
      'CREATE FUNCTION public.f() RETURNS void AS $$',
      'BEGIN',
      'SET transaction_timeout = 5;',
      'SET local_thing = 1;',
      'END',
      '$$ LANGUAGE plpgsql;',
    ].join('\n')

    const { sql, dropped } = dropUnsupportedSetStatements(dump, PG15_PARAMETERS)
    expect(dropped).toEqual(['transaction_timeout'])       // the preamble one only
    expect(sql).toContain('SET transaction_timeout = 5;')  // the body one survives
    expect(sql).toContain('SET local_thing = 1;')
  })

  it('stops filtering at the first real statement', () => {
    const dump = [
      'SET unknown_a = 1;',
      'CREATE TABLE public.t (id int);',
      'SET unknown_b = 2;',
    ].join('\n')

    const { sql, dropped } = dropUnsupportedSetStatements(dump, PG15_PARAMETERS)
    expect(dropped).toEqual(['unknown_a'])
    expect(sql).toContain('SET unknown_b = 2;')
  })

  it('is case-insensitive about the parameter name', () => {
    const { dropped } = dropUnsupportedSetStatements('SET Transaction_Timeout = 0;', PG15_PARAMETERS)
    expect(dropped).toEqual(['transaction_timeout'])
  })
})

describe('explainStructureFailure (issue #72)', () => {
  const raw = 'psql:<stdin>:13: ERROR:  unrecognized configuration parameter "transaction_timeout"'

  it('names the version gap when the client is newer than the server', () => {
    const msg = explainStructureFailure(raw, 18, 15)
    expect(msg).toContain(raw)
    expect(msg).toContain('client is PostgreSQL 18')
    expect(msg).toContain('target server is 15')
    expect(msg).toContain('postgresql-client-15')
  })

  it('says nothing about versions when there is no gap', () => {
    const msg = explainStructureFailure(raw, 15, 15)
    expect(msg).toContain(raw)
    expect(msg).not.toContain('client is PostgreSQL')
  })

  it('always says which step failed', () => {
    expect(explainStructureFailure('boom', 15, 15)).toContain("replay the target's structure")
  })
})
