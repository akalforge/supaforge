import { describe, it, expect } from 'vitest'
import { statementSubject } from '../src/sql-deps.js'
import { platformOwnedObject, tolerableFailure } from '../src/restore.js'
import { replaceableSchemas } from '../src/restore-replace.js'
import { destructiveReason } from '../src/dbdiff.js'
import { isEnumValueAddition } from '../src/promote.js'
import { diffGrants } from '../src/checks/roles.js'

const grant = (o: Record<string, unknown> = {}) => ({
  grantee: 'authenticated', table_schema: 'public', table_name: 'profiles',
  privilege_type: 'UPDATE', is_grantable: false, ...o,
})

describe('statementSubject: what a statement acts on, not what it mentions', () => {
  it('a webhook trigger belongs to its table', () => {
    expect(statementSubject(`CREATE TRIGGER "w" AFTER INSERT ON "public"."orders" FOR EACH ROW
      EXECUTE FUNCTION "supabase_functions"."http_request"('https://x', 'POST', '{}', '{}', '1000');`))
      .toEqual({ schema: 'public', name: 'orders' })
  })
  it('a view is its own subject, whatever it reads', () => {
    expect(statementSubject('CREATE VIEW public.job_health AS SELECT * FROM cron.job_run_details;'))
      .toEqual({ schema: 'public', name: 'job_health' })
  })
  it('schema-level statements name the schema', () => {
    expect(statementSubject('CREATE SCHEMA pgbouncer;')).toEqual({ schema: 'pgbouncer', name: 'pgbouncer' })
    expect(statementSubject('GRANT USAGE ON SCHEMA cron TO postgres;')).toEqual({ schema: 'cron', name: 'cron' })
  })
  it('a grant and a column comment name their table', () => {
    expect(statementSubject('GRANT SELECT ON "storage"."objects" TO "anon";')).toEqual({ schema: 'storage', name: 'objects' })
    expect(statementSubject(`COMMENT ON COLUMN public.t.c IS 'x';`)).toEqual({ schema: 'public', name: 't' })
  })
})

describe('platformOwnedObject by subject', () => {
  it('keeps Database Webhooks and views that read platform schemas', () => {
    expect(platformOwnedObject('CREATE TRIGGER w AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();')).toBeUndefined()
    expect(platformOwnedObject('CREATE VIEW public.keys AS SELECT name FROM vault.decrypted_secrets;')).toBeUndefined()
  })
  it('still skips what the platform owns', () => {
    expect(platformOwnedObject('CREATE FUNCTION pgbouncer.get_auth(p text) RETURNS text AS $$ $$;')).toBe('pgbouncer')
  })
})

describe('tolerableFailure', () => {
  const missing = { code: '3F000', message: 'schema "storage" does not exist' }
  it('skips a statement that needs a Supabase-only schema the target lacks', () => {
    expect(tolerableFailure('GRANT SELECT ON "storage"."objects" TO "anon";', missing)).toMatch(/storage/)
    expect(tolerableFailure('CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";',
      { code: '0A000', message: 'extension "pg_graphql" is not available' })).toMatch(/extension/)
  })
  it('fails the restore for anything else', () => {
    expect(tolerableFailure('CREATE TABLE public.t (id int);', { code: '42P07', message: 'exists' })).toBeUndefined()
    expect(tolerableFailure('CREATE VIEW public.v AS SELECT * FROM public.missing;', missing)).toBeUndefined()
    expect(tolerableFailure('GRANT SELECT ON storage.objects TO anon;', { code: '42501', message: 'denied' })).toBeUndefined()
  })
})

describe('replaceableSchemas', () => {
  it('never clears a platform schema', () => {
    expect(replaceableSchemas(['graphql', 'pgbouncer', 'public', 'reporting', 'auth', 'pg_temp']))
      .toEqual(['public', 'reporting'])
  })
})

describe('destructiveReason: TRUNCATE only as a statement', () => {
  it('does not gate a TRUNCATE privilege or trigger event', () => {
    expect(destructiveReason('GRANT TRUNCATE ON "public"."plans" TO "anon";')).toBeUndefined()
    expect(destructiveReason('REVOKE TRUNCATE ON "public"."plans" FROM "anon";')).toBeUndefined()
    expect(destructiveReason('CREATE TRIGGER a BEFORE TRUNCATE ON public.plans FOR EACH STATEMENT EXECUTE FUNCTION f();')).toBeUndefined()
  })
  it('still gates TRUNCATE itself', () => {
    expect(destructiveReason('TRUNCATE public.plans;')).toBeDefined()
    expect(destructiveReason('SELECT 1; TRUNCATE public.plans;')).toBeDefined()
  })
})

describe('isEnumValueAddition', () => {
  it('recognises label additions only', () => {
    expect(isEnumValueAddition(`ALTER TYPE "st" ADD VALUE IF NOT EXISTS 'paid' AFTER 'new';`)).toBe(true)
    expect(isEnumValueAddition(`ALTER TYPE "st" ADD VALUE 'a';\nALTER TABLE t ADD COLUMN c int;`)).toBe(false)
    expect(isEnumValueAddition('ALTER TYPE "st" RENAME TO s2;')).toBe(false)
  })
})

describe('diffGrants', () => {
  it('writes PUBLIC as the keyword, not a quoted role', () => {
    expect(diffGrants([grant({ grantee: 'PUBLIC', privilege_type: 'SELECT' })], [])[0].sql!.up)
      .toBe('GRANT SELECT ON "public"."profiles" TO PUBLIC;')
  })
  it('reports a grant option held on one side only', () => {
    const [issue] = diffGrants([grant({ is_grantable: true })], [grant()])
    expect(issue.id).toMatch(/^roles-grant-option-/)
    expect(issue.sql!.up).toContain('WITH GRANT OPTION')
  })
  it('keys and renders a column-level grant', () => {
    const [issue] = diffGrants([grant({ column_name: 'display_name' })], [])
    expect(issue.sql!.up).toBe('GRANT UPDATE ("display_name") ON "public"."profiles" TO "authenticated";')
    expect(diffGrants([grant({ column_name: 'a' })], [grant({ column_name: 'b' })])).toHaveLength(2)
  })
})
