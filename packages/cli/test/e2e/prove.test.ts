/**
 * Convergence proof, against real databases.
 *
 * These cannot be unit tests. The whole point of the proof is that it runs the
 * migration and looks at the result — a mocked database would only ever confirm
 * the mock. Each case here supplies a migration whose correctness is decided by
 * PostgreSQL, not by us.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { proveConvergence } from '../../src/prove.js'

let runtimeAvailable = true
try { PgHarness.detectRuntime() } catch { runtimeAvailable = false }
const describeE2E = runtimeAvailable ? describe : describe.skip

describeE2E('convergence proof', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE })
    await h.up()
  }, 180_000)

  afterAll(async () => { await h?.down() }, 60_000)

  // Each case owns its schema. Without this the databases accumulate every
  // earlier case's objects, so a proof's residual is dominated by unrelated
  // leftovers and an assertion can pass for the wrong reason.
  beforeEach(async () => {
    for (const role of ['source', 'target'] as const) {
      await h.applySql(role, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    }
  }, 60_000)

  const prove = (migrationSql: string) => proveConvergence({
    sourceUrl: h.connectionString('source'),
    targetUrl: h.connectionString('target'),
    migrationSql,
  })

  it('accepts a migration that reproduces the source', async () => {
    await h.applySql('source', 'CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);')
    const proof = await prove('CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);')

    expect(proof.skipped).toBeUndefined()
    expect(proof.converged).toBe(true)
    expect(proof.residual).toEqual([])
  }, 300_000)

  it('rejects a migration that runs cleanly but produces something else', async () => {
    // Valid SQL, applies without error, wrong result: the column is nullable
    // and the type differs. Exactly the shape that text comparison misses.
    //
    // The source is built explicitly. Without it this compared an empty schema
    // against one holding a table, which is a migration producing something
    // *extra* rather than something *else* — a weaker case than the name claims.
    await h.applySql('source', 'CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);')
    const proof = await prove('CREATE TABLE widgets (id bigint PRIMARY KEY, label varchar(10));')

    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/column public\.widgets\.label: type text → character varying\(10\)/)
    expect(proof.residual.join('\n')).toMatch(/not null yes → no/)
  }, 300_000)

  // The three below are regressions. The fingerprint used to compare objects
  // that carry a body by name alone, so each of these pairs — genuinely
  // different schemas, in the ways most likely to matter — was reported as
  // converged.

  it('catches a view whose body changed but whose name did not', async () => {
    await h.applySql('source', `
      CREATE TABLE readings (id int, n int);
      CREATE VIEW positive AS SELECT id, n FROM readings WHERE n > 0;
    `)

    const inverted = `
      CREATE TABLE readings (id int, n int);
      CREATE VIEW positive AS SELECT id, n FROM readings WHERE n < 0;
    `
    const proof = await prove(inverted)

    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/positive/)
  }, 300_000)

  it('catches a function whose implementation changed', async () => {
    await h.applySql('source', `
      CREATE FUNCTION answer() RETURNS int LANGUAGE sql IMMUTABLE AS $fn$ SELECT 1 $fn$;
    `)

    const proof = await prove(
      `CREATE FUNCTION answer() RETURNS int LANGUAGE sql IMMUTABLE AS $fn$ SELECT 999 $fn$;`,
    )

    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/answer/)
  }, 300_000)

  it('catches a trigger that moved to a different timing and event', async () => {
    await h.applySql('source', `
      CREATE TABLE audited (id int);
      CREATE FUNCTION note() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;
      CREATE TRIGGER watch AFTER INSERT ON audited FOR EACH ROW EXECUTE FUNCTION note();
    `)

    const movedTiming = `
      CREATE TABLE audited (id int);
      CREATE FUNCTION note() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;
      CREATE TRIGGER watch BEFORE UPDATE ON audited FOR EACH ROW EXECUTE FUNCTION note();
    `
    const proof = await prove(movedTiming)

    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/watch/)
  }, 300_000)

  it('catches a partition index that never reaches its partitions', async () => {
    // ON ONLY is correct when the index is created before partitions attach —
    // PostgreSQL propagates to partitions added later. It is wrong when the
    // partition already exists, and nothing about the SQL text says which case
    // you are in. Only replaying it can tell.
    await h.applySql('source', `
      CREATE TABLE sales (id bigint, d date NOT NULL, PRIMARY KEY (d, id))
        PARTITION BY RANGE (d);
      CREATE TABLE sales_2026 PARTITION OF sales
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE INDEX sales_d_idx ON sales (d);
    `)

    const attachThenIndex = `
      CREATE TABLE "sales" (id bigint, d date NOT NULL, CONSTRAINT sales_pkey PRIMARY KEY (d, id))
        PARTITION BY RANGE (d);
      CREATE TABLE "sales_2026" PARTITION OF "sales"
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE INDEX sales_d_idx ON ONLY public.sales USING btree (d);
    `
    const bad = await prove(attachThenIndex)
    expect(bad.converged).toBe(false)
    expect(bad.residual.join('\n')).toMatch(/sales_2026_d_idx/)

    // Same statements, index first: PostgreSQL propagates it on attach.
    const indexThenAttach = `
      CREATE TABLE "sales" (id bigint, d date NOT NULL, CONSTRAINT sales_pkey PRIMARY KEY (d, id))
        PARTITION BY RANGE (d);
      CREATE INDEX sales_d_idx ON ONLY public.sales USING btree (d);
      CREATE TABLE "sales_2026" PARTITION OF "sales"
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    `
    const good = await prove(indexThenAttach)
    expect(good.converged).toBe(true)
  }, 300_000)

  it('catches a partitioned table rebuilt as an ordinary one', async () => {
    // Applies cleanly, inserts keep working, partitioning silently gone —
    // the failure mode that has no error message at all.
    //
    // The source has to actually be partitioned for this to be the stated
    // case. Against an empty source it only proved the migration created a
    // table nobody asked for, which any difference at all would have shown.
    await h.applySql('source', `
      CREATE TABLE sales (id bigint, d date NOT NULL, PRIMARY KEY (d, id))
        PARTITION BY RANGE (d);
      CREATE TABLE sales_2026 PARTITION OF sales
        FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
    `)

    const flattened = `
      CREATE TABLE "sales" (id bigint, d date NOT NULL, CONSTRAINT sales_pkey PRIMARY KEY (d, id));
    `
    const proof = await prove(flattened)

    expect(proof.converged).toBe(false)
    const residual = proof.residual.join('\n')
    expect(residual).toMatch(/table public\.sales: kind partitioned_table → table/)
    expect(residual).toMatch(/table public\.sales_2026: missing/)
  }, 300_000)

  it('reports a migration that fails to execute, rather than claiming drift', async () => {
    await expect(prove('CREATE TABLE ;')).rejects.toThrow()
  }, 300_000)

  it('leaves no throwaway database behind', async () => {
    await prove('CREATE TABLE leftover_check (id int);').catch(() => undefined)
    const remaining = await h.sql('target',
      "SELECT count(*) FROM pg_database WHERE datname LIKE 'supaforge_prove_%'")
    expect(remaining).toBe('0')
  }, 300_000)
})
