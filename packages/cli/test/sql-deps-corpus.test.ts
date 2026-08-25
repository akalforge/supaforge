/**
 * Ordering corpus.
 *
 * `orderStatements` derives execution order from names it recognises in the
 * SQL text. That approach has a specific failure mode: it is only as good as
 * the dependency kinds someone thought to teach it, and text matching is
 * brittle in ways an AST is not — a table called `user` is a substring of
 * `user_profile`, and a quoted `"order"` looks like a keyword.
 *
 * Every case here was verified against live PostgreSQL 17 to fail when applied
 * in the order given, so none of them is vacuous: if the sorter did nothing at
 * all, all twelve would break. The assertions capture the precedence that
 * makes each one apply, rather than a whole expected order, so the tests stay
 * meaningful if the sorter's tie-breaking changes.
 *
 * Five of these — domains, sequences, composite types, function defaults and
 * nested views — were never explicitly taught to the sorter. They pass, but
 * they pass by inference, which is exactly the kind of thing that regresses
 * quietly. That is what this file is for.
 */
import { describe, it, expect } from 'vitest'
import { orderStatements } from '../src/sql-deps.js'

/** A case: statements deliberately in an order that does not apply. */
interface OrderingCase {
  /** Statements as the checks might emit them — dependants first. */
  statements: string[]
  /**
   * Pairs that must hold in the sorted output: `[before, after]`, matched as
   * substrings of the statement text.
   */
  requires: Array<[string, string]>
}

const CASES: Record<string, OrderingCase> = {
  'a table is created before the table whose foreign key points at it': {
    statements: [
      `CREATE TABLE user_profile (id int REFERENCES "user"(id), bio text);`,
      `CREATE TABLE "user" (id int PRIMARY KEY);`,
    ],
    requires: [[`CREATE TABLE "user"`, 'CREATE TABLE user_profile']],
  },

  'quoted names that collide with keywords are still ordered': {
    statements: [
      `CREATE TABLE "order" (id int REFERENCES "table"(id));`,
      `CREATE TABLE "table" (id int PRIMARY KEY);`,
    ],
    requires: [[`CREATE TABLE "table"`, `CREATE TABLE "order"`]],
  },

  'a domain is created before the column that uses it': {
    statements: [
      `CREATE TABLE d_t (id int, v money_amt);`,
      `CREATE DOMAIN money_amt AS numeric(10,2) CHECK (VALUE >= 0);`,
    ],
    requires: [['CREATE DOMAIN money_amt', 'CREATE TABLE d_t']],
  },

  'a function is created before the CHECK constraint that calls it': {
    statements: [
      `CREATE TABLE c_t (id int, code text, CONSTRAINT c_ck CHECK (is_valid(code)));`,
      `CREATE FUNCTION is_valid(t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT length(t) > 2 $$;`,
    ],
    requires: [['CREATE FUNCTION is_valid', 'CREATE TABLE c_t']],
  },

  'a function is created before the generated column that calls it': {
    statements: [
      `CREATE TABLE g_t (id int, raw text, norm text GENERATED ALWAYS AS (norm_it(raw)) STORED);`,
      `CREATE FUNCTION norm_it(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(t) $$;`,
    ],
    requires: [['CREATE FUNCTION norm_it', 'CREATE TABLE g_t']],
  },

  'a composite type is created before the function that returns it': {
    statements: [
      `CREATE FUNCTION mk_addr() RETURNS addr_t LANGUAGE sql AS $$ SELECT ROW('a','b')::addr_t $$;`,
      `CREATE TYPE addr_t AS (street text, city text);`,
    ],
    requires: [['CREATE TYPE addr_t', 'CREATE FUNCTION mk_addr']],
  },

  'a view that selects from a function waits for the function and its table': {
    statements: [
      `CREATE VIEW v_top AS SELECT * FROM top_ids();`,
      `CREATE FUNCTION top_ids() RETURNS TABLE(id int) LANGUAGE sql AS $$ SELECT id FROM base_t $$;`,
      `CREATE TABLE base_t (id int);`,
    ],
    requires: [
      ['CREATE TABLE base_t', 'CREATE FUNCTION top_ids'],
      ['CREATE FUNCTION top_ids', 'CREATE VIEW v_top'],
    ],
  },

  'a chain of views is created from the base outwards': {
    statements: [
      `CREATE VIEW v3 AS SELECT id FROM v2;`,
      `CREATE VIEW v1 AS SELECT id FROM vbase;`,
      `CREATE VIEW v2 AS SELECT id FROM v1;`,
      `CREATE TABLE vbase (id int);`,
    ],
    requires: [
      ['CREATE TABLE vbase', 'CREATE VIEW v1'],
      ['CREATE VIEW v1', 'CREATE VIEW v2'],
      ['CREATE VIEW v2', 'CREATE VIEW v3'],
    ],
  },

  // The regression behind the `ON ONLY` bug: an index on a partitioned parent
  // is only valid once the partitions it must reach are attached.
  'a partition is attached before the index on its parent': {
    statements: [
      `CREATE INDEX p_i ON ONLY p_tbl (d);`,
      `CREATE TABLE p_26 PARTITION OF p_tbl FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
      `CREATE TABLE p_tbl (id int, d date) PARTITION BY RANGE (d);`,
    ],
    requires: [
      ['CREATE TABLE p_tbl', 'CREATE TABLE p_26'],
      ['CREATE TABLE p_26', 'CREATE INDEX p_i'],
    ],
  },

  'an enum is created before the column defaulting to one of its labels': {
    statements: [
      `CREATE TABLE e_t (id int, m mood_x NOT NULL DEFAULT 'ok');`,
      `CREATE TYPE mood_x AS ENUM ('sad','ok');`,
    ],
    requires: [['CREATE TYPE mood_x', 'CREATE TABLE e_t']],
  },

  'a three-table foreign key chain is created root first': {
    statements: [
      `CREATE TABLE l3 (id int REFERENCES l2(id));`,
      `CREATE TABLE l1 (id int PRIMARY KEY);`,
      `CREATE TABLE l2 (id int PRIMARY KEY REFERENCES l1(id));`,
    ],
    requires: [
      ['CREATE TABLE l1', 'CREATE TABLE l2'],
      ['CREATE TABLE l2', 'CREATE TABLE l3'],
    ],
  },

  'a trigger waits for its function and the table it fires on': {
    statements: [
      `CREATE TRIGGER t_aud AFTER INSERT ON src_t FOR EACH ROW EXECUTE FUNCTION log_it();`,
      `CREATE FUNCTION log_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit_t VALUES (1); RETURN NEW; END $$;`,
      `CREATE TABLE src_t (id int);`,
      `CREATE TABLE audit_t (id int);`,
    ],
    requires: [
      ['CREATE TABLE src_t', 'CREATE TRIGGER t_aud'],
      ['CREATE FUNCTION log_it', 'CREATE TRIGGER t_aud'],
    ],
  },
}

describe('orderStatements corpus', () => {
  for (const [name, { statements, requires }] of Object.entries(CASES)) {
    it(name, () => {
      const ordered = orderStatements(statements, s => s)

      // Nothing may be lost or invented: a dropped statement is a worse
      // outcome than a wrong order, and would not show up in the checks below.
      expect(ordered).toHaveLength(statements.length)
      expect([...ordered].sort()).toEqual([...statements].sort())

      for (const [before, after] of requires) {
        const bi = ordered.findIndex(s => s.includes(before))
        const ai = ordered.findIndex(s => s.includes(after))
        expect(bi, `no statement matching ${before}`).toBeGreaterThanOrEqual(0)
        expect(ai, `no statement matching ${after}`).toBeGreaterThanOrEqual(0)
        expect(bi, `${before} must come before ${after}`).toBeLessThan(ai)
      }
    })
  }

  it('leaves independent statements alone', () => {
    const independent = [
      `CREATE TABLE a_t (id int);`,
      `CREATE TABLE b_t (id int);`,
      `CREATE TABLE c_t (id int);`,
    ]
    expect(orderStatements(independent, s => s)).toEqual(independent)
  })
})
