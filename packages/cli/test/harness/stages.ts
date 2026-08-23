/**
 * Fixture ladder — schema built up in stages, mirroring how a real project grows.
 *
 * Each stage is applied on top of the last, so a failure tells you exactly which
 * kind of object broke the diff (rather than "the big schema doesn't match").
 * Order is deliberate: plain tables first, then relationships and exotic column
 * types, then programmable objects, then the Supabase-specific surface.
 *
 * Keep every stage idempotent-ish (IF NOT EXISTS / OR REPLACE) so a stage can be
 * re-applied when reproducing a failure.
 */

export interface Stage {
  id: string;
  title: string;
  /** Supabase-specific stages need the auth/storage schemas to exist. */
  requiresSupabase?: boolean;
  sql: string;
}

export const STAGES: Stage[] = [
  {
    id: '01-tables',
    title: 'plain tables + data',
    sql: `
      CREATE TABLE IF NOT EXISTS customers (
        id          bigserial PRIMARY KEY,
        email       text NOT NULL UNIQUE,
        full_name   text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO customers (email, full_name)
      VALUES ('a@example.com','Ada Lovelace'), ('b@example.com','Alan Turing')
      ON CONFLICT (email) DO NOTHING;
    `,
  },
  {
    id: '02-relations-and-types',
    title: 'foreign keys + varied column types',
    sql: `
      CREATE TYPE order_status AS ENUM ('pending','paid','shipped','cancelled');

      CREATE TABLE IF NOT EXISTS orders (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id  bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        status       order_status NOT NULL DEFAULT 'pending',
        total_cents  integer NOT NULL CHECK (total_cents >= 0),
        -- deliberately awkward types: these are where diff tools tend to break
        metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
        tags         text[] DEFAULT ARRAY[]::text[],
        ratio        numeric(10,4),
        shipped_on   date,
        window_at    tstzrange,
        ip           inet,
        CONSTRAINT orders_total_sane CHECK (total_cents < 100000000)
      );

      CREATE TABLE IF NOT EXISTS order_lines (
        order_id   uuid REFERENCES orders(id) ON DELETE CASCADE,
        line_no    smallint,
        sku        text NOT NULL,
        qty        integer NOT NULL DEFAULT 1,
        PRIMARY KEY (order_id, line_no)
      );
    `,
  },
  {
    id: '03-functions-and-indexes',
    title: 'functions, triggers, indexes, views',
    sql: `
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
        LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

      ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

      DROP TRIGGER IF EXISTS customers_set_updated_at ON customers;
      CREATE TRIGGER customers_set_updated_at
        BEFORE UPDATE ON customers
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();

      CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
      -- partial + expression + GIN indexes exercise indexdef reconstruction
      CREATE INDEX IF NOT EXISTS orders_open_idx ON orders (customer_id)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS orders_meta_gin ON orders USING gin (metadata);
      CREATE INDEX IF NOT EXISTS customers_lower_email ON customers (lower(email));

      CREATE OR REPLACE VIEW customer_order_totals AS
        SELECT c.id, c.email, coalesce(sum(o.total_cents),0) AS lifetime_cents
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id, c.email;
    `,
  },
  {
    id: '04-rls',
    title: 'row level security policies',
    sql: `
      ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
      ALTER TABLE orders    ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS customers_self_read ON customers;
      CREATE POLICY customers_self_read ON customers
        FOR SELECT USING (true);

      DROP POLICY IF EXISTS orders_owner_rw ON orders;
      CREATE POLICY orders_owner_rw ON orders
        FOR ALL USING (customer_id IS NOT NULL) WITH CHECK (total_cents >= 0);
    `,
  },
  {
    id: '05-schemas-and-grants',
    title: 'extra schemas, sequences, grants',
    sql: `
      CREATE SCHEMA IF NOT EXISTS analytics;
      CREATE TABLE IF NOT EXISTS analytics.daily_totals (
        day date PRIMARY KEY,
        cents bigint NOT NULL DEFAULT 0
      );
      CREATE SEQUENCE IF NOT EXISTS analytics.batch_seq START 100 INCREMENT 5;
      GRANT USAGE ON SCHEMA analytics TO PUBLIC;
    `,
  },
];

/** A small, safe mutation used to prove --apply actually propagates changes. */
export const MUTATION_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_tier text DEFAULT 'bronze';
  CREATE INDEX IF NOT EXISTS customers_loyalty_idx ON customers (loyalty_tier);
`;
