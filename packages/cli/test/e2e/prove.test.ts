/**
 * Convergence proof, against real databases.
 *
 * These cannot be unit tests. The whole point of the proof is that it runs the
 * migration and looks at the result — a mocked database would only ever confirm
 * the mock. Each case here supplies a migration whose correctness is decided by
 * PostgreSQL, not by us.
 */
import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { proveConvergence } from '../../src/prove.js'

const describeE2E = describeWithContainers()

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

  // A CHECK, partial index or policy with `IN (...)` on a varchar column
  // renders one way as written and another once recreated from that
  // rendering, which is what the migration does in the clone. Compared with
  // the source as written, every such correct migration was refused.
  it('accepts an IN-list CHECK and partial index recreated from their rendering', async () => {
    const schema = `CREATE TABLE t (id int, status varchar(20), CONSTRAINT c CHECK (status IN ('draft', 'active')));
                    CREATE INDEX t_i ON t (id) WHERE status IN ('draft', 'active');`
    await h.applySql('source', schema)
    const proof = await prove(
      `CREATE TABLE t (id int, status varchar(20), CONSTRAINT c CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying])::text[]))));
       CREATE INDEX t_i ON t (id) WHERE ((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying])::text[]));`,
    )

    expect(proof.converged, proof.residual.join('\n')).toBe(true)
  }, 300_000)

  it('still reports a real difference beside one, and only that', async () => {
    await h.applySql('source', `CREATE TABLE t (id int, status varchar(20), CONSTRAINT c CHECK (status IN ('draft', 'active')));
                                COMMENT ON TABLE t IS 'only on the source';`)
    const proof = await prove(
      `CREATE TABLE t (id int, status varchar(20), CONSTRAINT c CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying])::text[]))));`,
    )

    expect(proof.converged).toBe(false)
    expect(proof.residual).toEqual(['table public.t: comment only on the source → none'])
  }, 300_000)

  // The clone used to hold only the proved schemas, so anything in them
  // leaning on another — a key onto auth.users, a policy calling auth.uid()
  // on Supabase — could not even be copied: `schema "auth" does not exist`.
  it('proves a schema leaning on another one', async () => {
    const base = `DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;
                  CREATE TABLE app.users (id int PRIMARY KEY);
                  CREATE FUNCTION app.uid() RETURNS int LANGUAGE sql STABLE AS 'SELECT 1';
                  CREATE TABLE profiles (id int, user_id int REFERENCES app.users (id));
                  ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;`
    await h.applySql('source', base + 'CREATE POLICY own ON profiles USING (user_id = app.uid());')
    await h.applySql('target', base)
    const proof = await prove('CREATE POLICY own ON profiles USING (user_id = app.uid());')

    expect(proof.skipped).toBeUndefined()
    expect(proof.converged, proof.residual.join('\n')).toBe(true)
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

  // A role is the server's, not the database's. Replaying `CREATE ROLE` in the
  // throwaway database created it for real, and the apply's own CREATE ROLE
  // then failed with "already exists". A migration needing a role the server
  // lacks is now declined, and nothing is created.
  it('does not create a role on the server to prove a policy for it', async () => {
    await h.applySql('source', 'CREATE TABLE t (id int);')
    const proof = await prove(
      'CREATE TABLE t (id int); ALTER TABLE t ENABLE ROW LEVEL SECURITY; '
      + 'CREATE POLICY p ON t TO sf_prove_absent_role USING (true);',
    )

    expect(proof.skipped).toContain('sf_prove_absent_role')
    expect(await h.sql('target', "SELECT count(*) FROM pg_roles WHERE rolname = 'sf_prove_absent_role'")).toBe('0')
  }, 300_000)
})
