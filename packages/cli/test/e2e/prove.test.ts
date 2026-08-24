/**
 * Convergence proof, against real databases.
 *
 * These cannot be unit tests. The whole point of the proof is that it runs the
 * migration and looks at the result — a mocked database would only ever confirm
 * the mock. Each case here supplies a migration whose correctness is decided by
 * PostgreSQL, not by us.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
    const proof = await prove('CREATE TABLE widgets (id bigint PRIMARY KEY, label varchar(10));')

    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/label/)
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
      CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);
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
      CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);
    `
    const good = await prove(indexThenAttach)
    expect(good.converged).toBe(true)
  }, 300_000)

  it('catches a partitioned table rebuilt as an ordinary one', async () => {
    // Applies cleanly, inserts keep working, partitioning silently gone —
    // the failure mode that has no error message at all.
    const flattened = `
      CREATE TABLE "sales" (id bigint, d date NOT NULL, CONSTRAINT sales_pkey PRIMARY KEY (d, id));
      CREATE TABLE "sales_2026" (id bigint, d date NOT NULL);
      CREATE INDEX sales_d_idx ON public.sales USING btree (d);
      CREATE TABLE widgets (id bigint PRIMARY KEY, label text NOT NULL);
    `
    const proof = await prove(flattened)
    expect(proof.converged).toBe(false)
    expect(proof.residual.join('\n')).toMatch(/kind=/)
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
