import { describe, it, expect } from 'vitest'
import {
  PHASE,
  statementPhase,
  sqlSkeleton,
  bareName,
  providedNames,
  referencedTables,
  orderStatements,
} from '../src/sql-deps.js'

/**
 * The exact fix set @dbdiff/cli produced for the two databases in issue #48,
 * in the order it reported them. Applying this top-to-bottom failed on
 * `schema-create-trigger-6`, because the trigger sorted ahead of the function
 * it executes.
 */
const ISSUE_48_FIXES = [
  { id: 'schema-drop-1', sql: 'DROP TABLE "legacy_notes";' },
  { id: 'schema-alter-2', sql: `ALTER TABLE "orders" ADD COLUMN "status" text DEFAULT 'pending'::text;` },
  { id: 'schema-alter-3', sql: 'ALTER TABLE "users" ADD COLUMN "created_at" timestamptz(6) DEFAULT now();' },
  { id: 'schema-create-index-4', sql: 'CREATE INDEX idx_orders_status ON public.orders USING btree (status);' },
  {
    id: 'schema-create-view-5',
    sql: `CREATE VIEW "active_orders" AS SELECT id, user_id, total FROM orders WHERE (status = 'pending'::text);`,
  },
  {
    id: 'schema-create-trigger-6',
    sql: 'CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();',
  },
  {
    id: 'schema-create-function-7',
    sql: 'CREATE OR REPLACE FUNCTION public.touch_updated()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END; $function$;',
  },
  {
    id: 'schema-alter-function-8',
    sql:
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\n' +
      'CREATE OR REPLACE FUNCTION public.calc_total(order_id integer)\n RETURNS numeric\n LANGUAGE sql\n' +
      'AS $function$SELECT total * 1.20 FROM orders WHERE id = order_id$function$;',
  },
]

function orderIds(fixes: { id: string; sql: string }[]): string[] {
  return orderStatements(fixes, f => f.sql).map(f => f.id)
}

describe('sqlSkeleton', () => {
  it('blanks dollar-quoted routine bodies', () => {
    const sql = 'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ CREATE TABLE inner_t (id int); $body$;'
    expect(sqlSkeleton(sql)).not.toMatch(/CREATE TABLE/i)
    expect(sqlSkeleton(sql)).toMatch(/CREATE FUNCTION/i)
  })

  it('blanks single-quoted literals, doubled quotes included', () => {
    expect(sqlSkeleton(`SELECT 'DROP TABLE x'`)).not.toMatch(/DROP TABLE/i)
    expect(sqlSkeleton(`SELECT 'it''s DROP TABLE x' , 1`)).not.toMatch(/DROP TABLE/i)
  })

  it('leaves a statement without literals untouched', () => {
    expect(sqlSkeleton('ALTER TABLE "orders" ADD COLUMN "n" int;')).toBe('ALTER TABLE "orders" ADD COLUMN "n" int;')
  })
})

describe('bareName', () => {
  it('strips quoting and the schema qualifier', () => {
    expect(bareName('"public"."orders"')).toBe('orders')
    expect(bareName('public.orders')).toBe('orders')
    expect(bareName('Orders')).toBe('orders')
  })
})

describe('statementPhase', () => {
  it('creates a routine before the trigger that executes it', () => {
    const fn = statementPhase('CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$ $$;')
    const trg = statementPhase('CREATE TRIGGER t BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();')
    expect(fn).toBeLessThan(trg)
  })

  it('does not read a trigger as a function just because it executes one', () => {
    const sql = 'CREATE TRIGGER t BEFORE UPDATE ON o FOR EACH ROW EXECUTE FUNCTION f();'
    expect(statementPhase(sql)).toBe(PHASE.CREATE_DEPENDANT)
  })

  it('creates tables before the columns, indexes and views that need them', () => {
    const table = statementPhase('CREATE TABLE "orders" (id int);')
    expect(table).toBeLessThan(statementPhase('ALTER TABLE "orders" ADD COLUMN s text;'))
    expect(table).toBeLessThan(statementPhase('CREATE INDEX i ON public.orders USING btree (s);'))
    expect(table).toBeLessThan(statementPhase('CREATE VIEW v AS SELECT * FROM orders;'))
  })

  it('drops dependants before what they depend on, and tables last', () => {
    expect(statementPhase('DROP TRIGGER t ON o;')).toBeLessThan(statementPhase('DROP FUNCTION IF EXISTS "f"();'))
    expect(statementPhase('DROP VIEW v;')).toBeLessThan(statementPhase('DROP TABLE "legacy_notes";'))
    expect(statementPhase('CREATE TABLE t (id int);')).toBeLessThan(statementPhase('DROP TABLE "legacy_notes";'))
  })

  it('phases a merged DROP + CREATE routine pair by what it leaves behind', () => {
    const merged =
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\nCREATE OR REPLACE FUNCTION public.calc_total(o integer) RETURNS numeric AS $$ $$;'
    expect(statementPhase(merged)).toBe(PHASE.CREATE_ROUTINE)
    // Still after the table changes its body may depend on.
    expect(statementPhase(merged)).toBeGreaterThan(statementPhase('ALTER TABLE "orders" ADD COLUMN s text;'))
  })

  it('runs data changes after the structure holding them', () => {
    expect(statementPhase('CREATE TABLE t (id int);')).toBeLessThan(statementPhase("INSERT INTO t VALUES (1);"))
    expect(statementPhase('CREATE VIEW v AS SELECT 1;')).toBeLessThan(statementPhase('UPDATE t SET id = 2;'))
  })

  it('gives an unrecognised statement a phase after the creates', () => {
    expect(statementPhase('GRANT SELECT ON t TO anon;')).toBe(PHASE.OTHER)
    expect(statementPhase('GRANT SELECT ON t TO anon;')).toBeGreaterThan(PHASE.CREATE_VIEW)
  })
})

describe('providedNames', () => {
  it('names what a statement creates, unqualified and unquoted', () => {
    expect(providedNames('CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$ $$;')).toEqual(['touch_updated'])
    expect(providedNames('CREATE VIEW "active_orders" AS SELECT 1;')).toEqual(['active_orders'])
    expect(providedNames('CREATE UNIQUE INDEX idx_a ON t (a);')).toEqual(['idx_a'])
    expect(providedNames('CREATE TABLE IF NOT EXISTS "public"."orders" (id int);')).toEqual(['orders'])
  })

  it('reports the name a merged DROP + CREATE pair recreates', () => {
    const merged =
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\nCREATE OR REPLACE FUNCTION public.calc_total(o integer) RETURNS numeric AS $$ $$;'
    expect(providedNames(merged)).toEqual(['calc_total'])
  })

  it('ignores objects created inside a routine body', () => {
    expect(providedNames('CREATE FUNCTION f() RETURNS void AS $b$ CREATE TABLE tmp_t (id int); $b$;')).toEqual(['f'])
  })

  it('reports nothing for a pure drop', () => {
    expect(providedNames('DROP TABLE "legacy_notes";')).toEqual([])
  })
})

describe('referencedTables', () => {
  it('finds the table a view selects from', () => {
    expect(referencedTables(`CREATE VIEW v AS SELECT id FROM orders WHERE (status = 'x');`)).toContain('orders')
  })

  it('finds the table an index or trigger hangs off', () => {
    expect(referencedTables('CREATE INDEX i ON public.orders USING btree (status);')).toEqual(['orders'])
    expect(
      referencedTables('CREATE TRIGGER t BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION f();'),
    ).toEqual(['orders'])
  })

  it('does not read the ON of a join condition as a table', () => {
    const sql = 'CREATE VIEW v AS SELECT * FROM orders o JOIN users u ON u.id = o.user_id;'
    expect(referencedTables(sql).sort()).toEqual(['orders', 'users'])
  })

  it('finds a foreign key target and the table being altered', () => {
    const sql = 'ALTER TABLE "orders" ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES "users"(id);'
    expect(referencedTables(sql).sort()).toEqual(['orders', 'users'])
  })

  it('looks inside a routine body', () => {
    const sql =
      'CREATE OR REPLACE FUNCTION calc(o integer) RETURNS numeric AS $f$SELECT total FROM orders WHERE id = o$f$;'
    expect(referencedTables(sql)).toContain('orders')
  })

  it('reports nothing for a statement that touches no table', () => {
    expect(referencedTables('CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$;')).toEqual([])
  })
})

describe('orderStatements', () => {
  it('puts the issue #48 fix set into an order that applies in one pass', () => {
    const ordered = orderIds(ISSUE_48_FIXES)

    // The reported failure: the trigger ran before the function it executes.
    expect(ordered.indexOf('schema-create-function-7')).toBeLessThan(ordered.indexOf('schema-create-trigger-6'))
    // The column the index and the view both need.
    expect(ordered.indexOf('schema-alter-2')).toBeLessThan(ordered.indexOf('schema-create-index-4'))
    expect(ordered.indexOf('schema-alter-2')).toBeLessThan(ordered.indexOf('schema-create-view-5'))
    // Destructive drops last, so nothing is removed out from under a fix.
    expect(ordered[ordered.length - 1]).toBe('schema-drop-1')
  })

  it('keeps every statement exactly once', () => {
    const ordered = orderIds(ISSUE_48_FIXES)
    expect(ordered).toHaveLength(ISSUE_48_FIXES.length)
    expect(new Set(ordered).size).toBe(ISSUE_48_FIXES.length)
  })

  it('is stable for statements that neither depend on each other nor differ in kind', () => {
    const fixes = [
      { id: 'a', sql: 'ALTER TABLE "a" ADD COLUMN x int;' },
      { id: 'b', sql: 'ALTER TABLE "b" ADD COLUMN y int;' },
      { id: 'c', sql: 'ALTER TABLE "c" ADD COLUMN z int;' },
    ]
    expect(orderIds(fixes)).toEqual(['a', 'b', 'c'])
  })

  it('creates a table before the view built on it, whatever order they arrive in', () => {
    const fixes = [
      { id: 'view', sql: 'CREATE VIEW v AS SELECT id FROM new_table;' },
      { id: 'table', sql: 'CREATE TABLE new_table (id int);' },
    ]
    expect(orderIds(fixes)).toEqual(['table', 'view'])
  })

  it('orders a chain of routines by the calls between them', () => {
    const fixes = [
      { id: 'outer', sql: 'CREATE OR REPLACE FUNCTION outer_fn() RETURNS int AS $$ SELECT inner_fn(); $$;' },
      { id: 'inner', sql: 'CREATE OR REPLACE FUNCTION inner_fn() RETURNS int AS $$ SELECT 1; $$;' },
    ]
    expect(orderIds(fixes)).toEqual(['inner', 'outer'])
  })

  it('does not hold a DROP back behind the CREATE of the same name', () => {
    const fixes = [
      { id: 'drop', sql: 'DROP TABLE "orders";' },
      { id: 'view', sql: 'CREATE VIEW v AS SELECT 1;' },
    ]
    // The drop is last because it is destructive, not because it waits on a
    // create — a cycle here would stall the sort.
    expect(orderIds(fixes)).toEqual(['view', 'drop'])
  })

  it('emits every statement even when references form a cycle', () => {
    const fixes = [
      { id: 'a', sql: 'CREATE TABLE a (id int, b_id int REFERENCES b(id));' },
      { id: 'b', sql: 'CREATE TABLE b (id int, a_id int REFERENCES a(id));' },
    ]
    expect(orderIds(fixes).sort()).toEqual(['a', 'b'])
  })

  it('handles the empty and single-statement cases', () => {
    expect(orderStatements([], (s: { sql: string }) => s.sql)).toEqual([])
    const one = [{ id: 'only', sql: 'CREATE TABLE t (id int);' }]
    expect(orderIds(one)).toEqual(['only'])
  })
})
