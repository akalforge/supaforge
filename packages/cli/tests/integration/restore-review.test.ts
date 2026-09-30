/**
 * Restore and apply behaviour that only a live server can prove, added after
 * reviewing the #95/#88 fixes on this branch.
 *
 *   - A Supabase-shaped snapshot restored into plain PostgreSQL skips what
 *     cannot exist there — a foreign key to auth.users, a Database Webhook, a
 *     grant on storage.objects, pg_graphql — by name, and restores the rest,
 *     instead of rolling back everything on the first of them. A table that
 *     cannot be created still fails the restore.
 *   - `--force` clears the snapshot's own schemas' contents, never a platform
 *     schema, keeps the schema's grants and default privileges, and puts back
 *     the trigger on auth.users that calls a public function; it refuses,
 *     changing nothing, when something else outside would be lost.
 *   - A Database Webhook is restored where its function exists.
 *   - An enum label added by a fix can be used by a later fix in the same apply.
 *   - The data fingerprint ignores physical order and sees a same-size change.
 *
 * Each case uses its own scratch database on the target server, dropped
 * afterwards. Snapshots are written by hand so the cases do not depend on the
 * runner having a pg_dump for the server's version.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { restoreFromSnapshot } from '../../src/restore'
import { promote } from '../../src/promote'
import { tablesMatch } from '../../src/checksum'
import { sqlToIssues } from '../../src/dbdiff'
import type { ScanResult } from '../../src/types/drift'
import { TARGET_URL, skipIfNoContainers } from './helpers'

const skip = skipIfNoContainers()
const stamp = Date.now()
const created: string[] = []
const dirs: string[] = []

function dbUrl(db: string): string {
  const u = new URL(TARGET_URL!)
  u.pathname = `/${db}`
  return u.toString()
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TARGET_URL! })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

async function scratch(name: string, sql = ''): Promise<string> {
  const db = `sf_rv_${name}_${stamp}`
  await admin(c => c.query(`CREATE DATABASE ${db}`))
  created.push(db)
  if (sql) await run(db, sql)
  return db
}

async function run(db: string, sql: string): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: dbUrl(db) })
  await c.connect()
  try { return await c.query(sql) } finally { await c.end() }
}

async function one(db: string, sql: string): Promise<unknown> {
  const { rows } = await run(db, sql)
  return rows[0] ? Object.values(rows[0])[0] : undefined
}

/** A snapshot directory holding the given layer files. */
async function snapshot(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sf-rv-'))
  dirs.push(dir)
  const layerOf: Record<string, string> = {
    'schema.sql': 'schema', 'extensions.sql': 'extensions', 'rls.sql': 'rls',
    'roles.sql': 'roles', 'webhooks.sql': 'webhooks', 'realtime.sql': 'realtime',
  }
  const layers: Record<string, unknown> = {}
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content)
    const layer = layerOf[file]
    // schema's own file is schema.json; the restore reads schema.sql beside it.
    layers[layer] = { captured: true, file: layer === 'schema' ? 'schema.json' : file, itemCount: 1 }
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    version: 1, timestamp: new Date().toISOString(), environment: 'test', layers,
  }))
  return dir
}

/** The shape of a pg_dump of a Supabase project's public schema. */
const SUPABASE_PUBLIC_DUMP = `
SET check_function_bodies = false;
CREATE SCHEMA IF NOT EXISTS public;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, name text);
CREATE TABLE public.orders (id bigint PRIMARY KEY, owner uuid);
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id); RETURN NEW; END $$;
ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.test/hook', 'POST', '{}', '{}', '1000');
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON public.orders USING (owner = auth.uid());
`

const SUPABASE_ROLES = `
GRANT SELECT ON "public"."orders" TO "sf_rv_anon";
GRANT SELECT ON "storage"."objects" TO "sf_rv_anon";
`

afterAll(async () => {
  if (skip) return
  for (const db of created) {
    await admin(async c => {
      await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db])
      await c.query(`DROP DATABASE IF EXISTS ${db}`)
    })
  }
  await admin(c => c.query('DROP ROLE IF EXISTS sf_rv_anon'))
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('restore: a Supabase snapshot into plain PostgreSQL', () => {
  it.skipIf(skip)('restores what it can and names what it skipped', async () => {
    const db = await scratch('plain')
    const dir = await snapshot({
      'extensions.sql': 'CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";',
      'schema.sql': SUPABASE_PUBLIC_DUMP,
      'roles.sql': SUPABASE_ROLES,
    })

    const result = await restoreFromSnapshot({ snapshotDir: dir, targetUrl: dbUrl(db) })

    expect(result.errors).toEqual([])
    expect(result.rolledBack).toBeUndefined()
    expect(await one(db, `SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'`)).toBe(2)
    expect(await one(db, `SELECT count(*)::int FROM pg_policies WHERE policyname = 'own'`)).toBe(0)

    const skipped = result.skipped.map(s => `${s.label} :: ${s.reason}`).join('\n')
    expect(skipped).toMatch(/pg_graphql[\s\S]*extension not available/)
    expect(skipped).toMatch(/profiles_id_fkey[\s\S]*auth/)
    expect(skipped).toMatch(/orders_webhook[\s\S]*supabase_functions/)
    expect(skipped).toMatch(/storage/)
    // The grant on a public table is not a platform artefact: it applies.
    expect(await one(db, `SELECT has_table_privilege('sf_rv_anon', 'public.orders', 'SELECT')`)).toBe(true)
  })

  it.skipIf(skip)('still fails, and changes nothing, when a table cannot be created', async () => {
    const db = await scratch('table')
    const dir = await snapshot({
      'schema.sql': `CREATE TABLE public.keep (id int);
                     CREATE TABLE public.needs_auth (id uuid DEFAULT auth.uid());`,
    })

    const result = await restoreFromSnapshot({ snapshotDir: dir, targetUrl: dbUrl(db) })

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.applied).toEqual([])
    expect(await one(db, `SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'`)).toBe(0)
  })
})

describe('restore --force', () => {
  /** A target shaped like a Supabase project, with an older public schema. */
  const TARGET = `
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE SCHEMA graphql;
    CREATE FUNCTION graphql.resolve() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
    DO $$ BEGIN CREATE ROLE sf_rv_anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    GRANT USAGE ON SCHEMA public TO sf_rv_anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sf_rv_anon;
    CREATE TABLE public.stale (id int);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, name text, old_col int);
    CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  `
  const SNAPSHOT = `
    SET check_function_bodies = false;
    CREATE SCHEMA graphql;
    CREATE SCHEMA public;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, name text);
    CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id); RETURN NEW; END $$;
  `

  it.skipIf(skip)('replaces the snapshot\'s objects and keeps everything outside them', async () => {
    const db = await scratch('force', TARGET)
    const dir = await snapshot({ 'schema.sql': SNAPSHOT })

    const result = await restoreFromSnapshot({ snapshotDir: dir, targetUrl: dbUrl(db), replace: true })

    expect(result.errors).toEqual([])
    // Replaced: the stale table is gone and profiles lost the column the snapshot lacks.
    expect(await one(db, `SELECT count(*)::int FROM pg_tables WHERE tablename = 'stale'`)).toBe(0)
    expect(await one(db, `SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'old_col'`)).toBe(0)
    // Put back: the trigger on auth.users, which no snapshot layer captures.
    expect(await one(db, `SELECT count(*)::int FROM pg_trigger WHERE tgname = 'on_auth_user_created'`)).toBe(1)
    await run(db, `INSERT INTO auth.users VALUES ('6f1c4b8e-7d1c-4b4a-9a55-6c1f3c1d2e3f')`)
    expect(await one(db, `SELECT count(*)::int FROM public.profiles`)).toBe(1)
    // Untouched: a platform schema the dump mentions.
    expect(await one(db, `SELECT count(*)::int FROM pg_proc WHERE proname = 'resolve'`)).toBe(1)
    // Kept: the schema's grants and default privileges.
    expect(await one(db, `SELECT has_schema_privilege('sf_rv_anon', 'public', 'USAGE')`)).toBe(true)
    expect(await one(db, `SELECT has_table_privilege('sf_rv_anon', 'public.profiles', 'SELECT')`)).toBe(true)
  })

  it.skipIf(skip)('refuses, changing nothing, when an outside object cannot be put back', async () => {
    const db = await scratch('refuse', `
      CREATE TYPE public.status AS ENUM ('a', 'b');
      CREATE TABLE public.keep (id int);
      CREATE SCHEMA other;
      CREATE TABLE other.uses_it (s public.status);
    `)
    const dir = await snapshot({ 'schema.sql': 'CREATE TABLE public.keep (id int);' })

    const result = await restoreFromSnapshot({ snapshotDir: dir, targetUrl: dbUrl(db), replace: true })

    expect(result.errors.map(e => e.error).join()).toMatch(/other\.uses_it/)
    expect(await one(db, `SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'other' AND column_name = 's'`)).toBe(1)
    expect(await one(db, `SELECT count(*)::int FROM pg_type WHERE typname = 'status'`)).toBe(1)
  })
})

describe('restore: a Database Webhook where its function exists', () => {
  it.skipIf(skip)('is restored, not skipped as platform-owned', async () => {
    const db = await scratch('webhook', `
      CREATE SCHEMA supabase_functions;
      CREATE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NEW; END $$;
    `)
    const dir = await snapshot({
      'schema.sql': `CREATE TABLE public.orders (id bigint PRIMARY KEY);
        CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW
          EXECUTE FUNCTION supabase_functions.http_request('https://example.test/hook', 'POST', '{}', '{}', '1000');`,
    })

    const result = await restoreFromSnapshot({ snapshotDir: dir, targetUrl: dbUrl(db) })

    expect(result.errors).toEqual([])
    expect(await one(db, `SELECT count(*)::int FROM pg_trigger WHERE tgname = 'orders_webhook'`)).toBe(1)
  })
})

describe('apply: an enum label used in the same apply', () => {
  it.skipIf(skip)('commits the label first, so the later fix can use it', async () => {
    const db = await scratch('enum', `
      CREATE TYPE public.st AS ENUM ('new', 'shipped');
      CREATE TABLE public.o (id int, s public.st DEFAULT 'new');
    `)
    const scan: ScanResult = {
      timestamp: new Date().toISOString(), source: 's', target: 't', score: 0,
      checks: [{
        check: 'schema', status: 'drifted', durationMs: 1,
        issues: [
          { id: 'default', check: 'schema', severity: 'warning', title: 'd', description: 'd',
            sql: { up: `ALTER TABLE "o" ALTER COLUMN "s" SET DEFAULT 'paid'::st;`, down: '' } },
          { id: 'label', check: 'schema', severity: 'warning', title: 'l', description: 'l',
            sql: { up: `ALTER TYPE "st" ADD VALUE IF NOT EXISTS 'paid' AFTER 'new';`, down: '' } },
        ],
      }],
    } as unknown as ScanResult

    const result = await promote({ dbUrl: dbUrl(db), scanResult: scan })

    expect(result.errors).toEqual([])
    await run(db, 'INSERT INTO public.o (id) VALUES (1)')
    expect(await one(db, 'SELECT s::text FROM public.o')).toBe('paid')
  })
})

describe('apply: a column type change bracketed by its dependants', () => {
  it.skipIf(skip)('applies as one change, alongside the policy it changes', async () => {
    const db = await scratch('bracket', `
      DO $$ BEGIN CREATE ROLE sf_rv_anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE public.orders (id int PRIMARY KEY, user_id text, amount numeric(10,2));
      INSERT INTO public.orders VALUES (1, '6f1c4b8e-7d1c-4b4a-9a55-6c1f3c1d2e3f', 9.5);
      CREATE VIEW public.paid_orders WITH (security_barrier = true) AS SELECT id, user_id, amount FROM public.orders;
      GRANT SELECT ON public.paid_orders TO sf_rv_anon;
      ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON public.orders USING (user_id = current_setting('app.uid', true));
    `)
    // What @dbdiff/cli emits for this change: two retypes under one view, and
    // the policy's own change. Split by statement, as the schema check does.
    const view = [
      'CREATE VIEW "paid_orders" WITH (security_barrier=true) AS SELECT orders.id, orders.user_id, orders.amount FROM orders;',
      'GRANT SELECT ON "paid_orders" TO sf_rv_anon;',
    ]
    const up = [
      'DROP VIEW IF EXISTS "paid_orders";',
      'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE numeric(12,2);',
      ...view,
      'DROP POLICY IF EXISTS "own" ON "orders";',
      'DROP VIEW IF EXISTS "paid_orders";',
      'ALTER TABLE "orders" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;',
      ...view,
      'DROP POLICY IF EXISTS "own" ON "orders";',
      `CREATE POLICY "own" ON "orders" FOR ALL USING ((user_id = (current_setting('app.uid'::text, true))::uuid));`,
    ].join('\n')
    const issues = sqlToIssues({ up, down: '' }, 'schema')
    expect(issues).toHaveLength(3)

    const result = await promote({
      dbUrl: dbUrl(db),
      scanResult: {
        timestamp: '', source: 's', target: 't', score: 0,
        checks: [{ check: 'schema', status: 'drifted', issues, durationMs: 1 }],
      } as unknown as ScanResult,
    })

    expect(result.errors).toEqual([])
    expect(result.skipped).toEqual([])
    expect(await one(db, `SELECT pg_typeof(user_id)::text FROM public.orders`)).toBe('uuid')
    expect(await one(db, `SELECT reloptions::text FROM pg_class WHERE relname = 'paid_orders'`)).toBe('{security_barrier=true}')
    expect(await one(db, `SELECT has_table_privilege('sf_rv_anon', 'public.paid_orders', 'SELECT')`)).toBe(true)
    expect(await one(db, `SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'own'`))
      .toMatch(/::uuid/)
  })
})

describe('data fingerprint', () => {
  let a: string
  let b: string
  beforeAll(async () => {
    if (skip) return
    a = await scratch('fp_a', `CREATE TABLE plans (id int, name text);
      INSERT INTO plans VALUES (1, 'free'), (2, 'pro'), (3, 'team');`)
    b = await scratch('fp_b', `CREATE TABLE plans (id int, name text);
      INSERT INTO plans VALUES (3, 'team'), (1, 'free'), (2, 'pro');`)
  })

  it.skipIf(skip)('matches the same rows in a different physical order', async () => {
    expect(await tablesMatch(dbUrl(a), dbUrl(b), 'plans')).toBe(true)
  })

  it.skipIf(skip)('sees a same-length value change', async () => {
    await run(b, `UPDATE plans SET name = 'prx' WHERE id = 2`)
    expect(await tablesMatch(dbUrl(a), dbUrl(b), 'plans')).toBe(false)
  })

  it.skipIf(skip)('sees a duplicated row', async () => {
    await run(b, `UPDATE plans SET name = 'pro' WHERE id = 2; INSERT INTO plans VALUES (1, 'free')`)
    await run(a, `INSERT INTO plans VALUES (2, 'pro')`)
    // Same count, same set of distinct rows, different multiset.
    expect(await tablesMatch(dbUrl(a), dbUrl(b), 'plans')).toBe(false)
  })
})
