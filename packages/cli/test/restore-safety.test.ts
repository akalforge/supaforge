import { describe, it, expect } from 'vitest'
import {
  platformOwnedObject,
  webhookTriggerKey,
  extensionTargetSchema,
  isSystemSchema,
} from '../src/restore.js'

/**
 * What a snapshot restore refuses to attempt, and what it prepares first (#95).
 *
 * A Supabase snapshot captures objects the project can read and never
 * recreate, and a Supabase schema dump assumes schemas that plain PostgreSQL
 * does not have. Both failed on every restore.
 */
describe('platformOwnedObject', () => {
  it('recognises the pgbouncer function a Supabase snapshot carries', () => {
    // `permission denied for schema pgbouncer` on every restore.
    expect(platformOwnedObject(
      'CREATE FUNCTION pgbouncer.get_auth(p_usename text) RETURNS TABLE(username text) AS $$ SELECT 1 $$;',
    )).toBe('pgbouncer')
  })

  it("recognises pg_cron's own policies", () => {
    // `must be owner of relation job`.
    expect(platformOwnedObject('CREATE POLICY "cron_job_policy" ON "cron"."job" USING (true);'))
      .toBe('cron')
    expect(platformOwnedObject('DROP POLICY IF EXISTS "cron_job_policy" ON "cron"."job";'))
      .toBe('cron')
  })

  it('leaves the project\'s own objects alone', () => {
    expect(platformOwnedObject('CREATE TABLE public.orders (id bigserial PRIMARY KEY);')).toBeUndefined()
    expect(platformOwnedObject('CREATE POLICY "p" ON "public"."orders" USING (true);')).toBeUndefined()
    expect(platformOwnedObject('CREATE FUNCTION public.bump(o bigint) RETURNS void AS $$ $$;')).toBeUndefined()
  })

  it('does not match a mention inside a literal or a body', () => {
    // Read off the skeleton, so a body referring to cron does not make the
    // statement the platform's.
    expect(platformOwnedObject(
      `CREATE FUNCTION public.f() RETURNS text AS $$ SELECT 'cron.job' $$ LANGUAGE sql;`,
    )).toBeUndefined()
  })

  it('does not match an unrelated statement that merely names a table', () => {
    expect(platformOwnedObject('SELECT 1;')).toBeUndefined()
  })
})

describe('webhookTriggerKey', () => {
  it('keys a trigger by table and name', () => {
    // A trigger name is unique only per table — the keying #77 settled on.
    expect(webhookTriggerKey(
      'CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();',
    )).toBe('public.orders.orders_webhook')
  })

  it('matches the same trigger however it is quoted', () => {
    const a = webhookTriggerKey('CREATE TRIGGER "orders_webhook" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION f();')
    const b = webhookTriggerKey('CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();')

    // The schema dump and the webhooks layer render the same trigger
    // differently; if these did not match, the trigger would be created twice
    // and the second attempt would fail.
    expect(a).toBe(b)
  })

  it('distinguishes the same name on two tables', () => {
    expect(webhookTriggerKey('CREATE TRIGGER t AFTER INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION f();'))
      .not.toBe(webhookTriggerKey('CREATE TRIGGER t AFTER INSERT ON public.b FOR EACH ROW EXECUTE FUNCTION f();'))
  })

  it('is null for anything that is not a trigger', () => {
    expect(webhookTriggerKey('CREATE TABLE public.t (id int);')).toBeNull()
  })
})

describe('extensionTargetSchema', () => {
  it('names the schema a Supabase extension needs', () => {
    // `schema "extensions" does not exist` on plain PostgreSQL, for every one.
    expect(extensionTargetSchema('CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";'))
      .toBe('extensions')
  })

  it('does not ask for a system schema', () => {
    // `plpgsql` lives in pg_catalog. Asking for that one is an error rather
    // than a no-op, and inside a transaction it takes the whole restore with
    // it — which is what a first attempt at this fix did.
    expect(extensionTargetSchema('CREATE EXTENSION IF NOT EXISTS "plpgsql" WITH SCHEMA "pg_catalog";'))
      .toBeUndefined()
  })

  it('is undefined when no schema is named', () => {
    expect(extensionTargetSchema('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')).toBeUndefined()
    expect(extensionTargetSchema('CREATE TABLE public.t (id int);')).toBeUndefined()
  })
})

describe('isSystemSchema', () => {
  it('recognises the schemas that cannot be created', () => {
    // PostgreSQL rejects a `pg_` name before it evaluates IF NOT EXISTS — the
    // same trap that aborted --prove in #94.
    expect(isSystemSchema('pg_catalog')).toBe(true)
    expect(isSystemSchema('information_schema')).toBe(true)
    expect(isSystemSchema('pg_temp_1')).toBe(true)
  })

  it('does not catch a schema that merely starts with pg', () => {
    // `pgsodium` is an ordinary schema a column default genuinely needs.
    expect(isSystemSchema('pgsodium')).toBe(false)
    expect(isSystemSchema('public')).toBe(false)
    expect(isSystemSchema('extensions')).toBe(false)
  })
})
