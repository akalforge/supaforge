import type pg from 'pg'
import { SUPABASE_PLATFORM_SCHEMAS } from './defaults'

/**
 * What `restore --force` clears, and what it must put back.
 *
 * `--force` replaces the snapshot's objects in the target. It used to do that
 * with `DROP SCHEMA ... CASCADE` on every schema the dump mentioned, which was
 * wrong three ways:
 *
 *   - The dump mentions platform schemas — a Supabase dump carries
 *     `CREATE SCHEMA graphql` and `CREATE SCHEMA pgbouncer` — so they were
 *     dropped too. As `postgres` that fails ("must be owner of schema
 *     graphql"), so `--force` never worked against Supabase; as a superuser it
 *     would have removed `pgbouncer.get_auth`, which the restore then skips as
 *     platform-owned and never puts back.
 *   - CASCADE reaches out of the schema. `on_auth_user_created`, the trigger
 *     on `auth.users` that calls `public.handle_new_user()`, is dropped with
 *     `public` — and no snapshot layer captures `auth`, so it was lost for
 *     good, silently. Storage policies calling a `public` function go the
 *     same way.
 *   - Dropping the schema itself drops its grants and default privileges. On
 *     Supabase those are what give `anon` and `authenticated` USAGE on
 *     `public` and their privileges on every new table.
 *
 * So the schemas stay and only their contents go; platform schemas are never
 * touched; and whatever outside them depends on what is dropped is captured
 * first and recreated afterwards — or, where it is something that cannot be
 * put back faithfully, the restore refuses before changing anything.
 */

/** Schemas `--force` never clears, whatever the dump mentions. */
const NEVER_CLEARED = new Set(SUPABASE_PLATFORM_SCHEMAS)

/** The schemas `--force` may clear: the snapshot's own, never the platform's. */
export function replaceableSchemas(snapshotSchemas: string[]): string[] {
  return snapshotSchemas.filter(s => !NEVER_CLEARED.has(s) && !s.startsWith('pg_'))
}

/** An object outside the cleared schemas that depends on something inside them. */
export interface ExternalDependent {
  kind: 'trigger' | 'policy'
  schema: string
  table: string
  name: string
  /** The DDL that puts it back. */
  ddl: string
}

export interface ExternalDependents {
  /** Triggers and policies, captured so they can be recreated. */
  recreate: ExternalDependent[]
  /** Anything else — a column, a constraint, a view — described for the refusal. */
  blockers: string[]
}

/**
 * Objects outside `schemas` that a CASCADE of their contents would drop.
 *
 * Read from pg_depend: every normal dependency whose referenced object lives in
 * one of `schemas` and whose dependent does not. Triggers and policies can be
 * reproduced exactly from the catalog, so they are captured; anything else is
 * reported as a blocker, because dropping it would lose data (a column of an
 * enum type) or structure this restore does not own (a view in another
 * schema).
 *
 * Captured with an empty search_path so every name in the DDL is qualified:
 * `public.handle_new_user()`, not a bare name that happens to resolve today.
 */
export async function findExternalDependents(
  client: pg.Client,
  schemas: string[],
): Promise<ExternalDependents> {
  if (schemas.length === 0) return { recreate: [], blockers: [] }

  const { rows: [{ search_path: previous }] } = await client.query<{ search_path: string }>(
    'SHOW search_path',
  )
  await client.query(`SELECT set_config('search_path', '', false)`)
  try {
    const { rows } = await client.query<{
      kind: string; identity: string; schema: string | null
      trigger_ddl: string | null; policy_ddl: string | null
      table_schema: string | null; table_name: string | null; object_name: string | null
    }>(EXTERNAL_DEPENDENTS_SQL, [schemas])

    const recreate: ExternalDependent[] = []
    const blockers: string[] = []
    const seen = new Set<string>()

    for (const row of rows) {
      if (seen.has(row.identity)) continue
      seen.add(row.identity)

      if (row.kind === 'trigger' && row.trigger_ddl) {
        recreate.push({
          kind: 'trigger', schema: row.table_schema!, table: row.table_name!,
          name: row.object_name!, ddl: `${row.trigger_ddl};`,
        })
      } else if (row.kind === 'policy' && row.policy_ddl) {
        recreate.push({
          kind: 'policy', schema: row.table_schema!, table: row.table_name!,
          name: row.object_name!, ddl: `${row.policy_ddl};`,
        })
      } else {
        blockers.push(`${row.kind} ${row.identity}`)
      }
    }

    return { recreate, blockers }
  } finally {
    await client.query(`SELECT set_config('search_path', $1, false)`, [previous])
  }
}

const EXTERNAL_DEPENDENTS_SQL = `
  -- What clearing drops: everything in the schemas except extension members,
  -- which dropSchemaContents leaves in place. Counting those would refuse a
  -- --force over, say, an auth default calling public.uuid_generate_v4()
  -- from an extension installed in public, which is never dropped.
  WITH members AS (
    SELECT objid FROM pg_depend WHERE deptype = 'e'
  ),
  inside AS (
    SELECT c.oid, 'pg_class'::regclass AS classid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND c.oid NOT IN (SELECT objid FROM members)
    UNION ALL
    SELECT p.oid, 'pg_proc'::regclass
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1) AND p.oid NOT IN (SELECT objid FROM members)
    UNION ALL
    SELECT t.oid, 'pg_type'::regclass
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1) AND t.oid NOT IN (SELECT objid FROM members)
  ),
  dependents AS (
    SELECT DISTINCT d.classid, d.objid, d.objsubid
      FROM pg_depend d
      JOIN inside i ON i.oid = d.refobjid AND i.classid = d.refclassid
     WHERE d.deptype = 'n'
  )
  SELECT o.type AS kind, o.identity, o.schema,
         CASE WHEN dep.classid = 'pg_trigger'::regclass
              THEN pg_get_triggerdef(dep.objid) END AS trigger_ddl,
         CASE WHEN dep.classid = 'pg_policy'::regclass THEN (
           SELECT format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
                    p.polname, pn.nspname, pc.relname,
                    CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                    CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                  WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
                    CASE WHEN p.polroles = '{0}' THEN 'PUBLIC'
                         ELSE (SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
                                 FROM pg_roles r WHERE r.oid = ANY (p.polroles)) END,
                    CASE WHEN p.polqual IS NOT NULL
                         THEN ' USING (' || pg_get_expr(p.polqual, p.polrelid) || ')' ELSE '' END,
                    CASE WHEN p.polwithcheck IS NOT NULL
                         THEN ' WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')' ELSE '' END)
             FROM pg_policy p
             JOIN pg_class pc ON pc.oid = p.polrelid
             JOIN pg_namespace pn ON pn.oid = pc.relnamespace
            WHERE p.oid = dep.objid) END AS policy_ddl,
         COALESCE(tn.nspname, pn.nspname) AS table_schema,
         COALESCE(tc.relname, pc.relname) AS table_name,
         COALESCE(t.tgname, p.polname) AS object_name
    FROM dependents dep
    CROSS JOIN LATERAL pg_identify_object(dep.classid, dep.objid, dep.objsubid) o
    LEFT JOIN pg_trigger t    ON dep.classid = 'pg_trigger'::regclass AND t.oid = dep.objid
    LEFT JOIN pg_class tc     ON tc.oid = t.tgrelid
    LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    LEFT JOIN pg_policy p     ON dep.classid = 'pg_policy'::regclass AND p.oid = dep.objid
    LEFT JOIN pg_class pc     ON pc.oid = p.polrelid
    LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
   WHERE o.schema IS NULL OR NOT (o.schema = ANY($1))
   ORDER BY o.type, o.identity
`

/**
 * Drop every object in `schemas`, keeping the schemas themselves.
 *
 * Keeping the schema keeps its grants and default privileges, which the dump
 * does not carry (it is taken with --no-privileges). Extension members are
 * left alone: the extension owns them, DROP refuses them, and the extensions
 * layer puts the extension back if it is missing.
 *
 * @returns how many objects were dropped
 */
export async function dropSchemaContents(client: pg.Client, schemas: string[]): Promise<number> {
  if (schemas.length === 0) return 0

  const { rows } = await client.query<{ statement: string }>(DROP_CONTENTS_SQL, [schemas])
  for (const { statement } of rows) {
    await client.query(statement)
  }
  return rows.length
}

// Views before tables before routines before types, so most drops find their
// object still there; IF EXISTS covers what an earlier CASCADE already took.
const DROP_CONTENTS_SQL = `
  WITH members AS (
    SELECT objid FROM pg_depend WHERE deptype = 'e'
  )
  SELECT statement FROM (
    SELECT 1 AS phase, format('DROP %s IF EXISTS %I.%I CASCADE',
             CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                            WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE'
                            ELSE 'TABLE' END,
             n.nspname, c.relname) AS statement,
           n.nspname || '.' || c.relname AS sort_key
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1)
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.oid NOT IN (SELECT objid FROM members)
    UNION ALL
    SELECT 2, format('DROP %s IF EXISTS %s CASCADE',
             CASE p.prokind WHEN 'a' THEN 'AGGREGATE' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
             p.oid::regprocedure::text),
           p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY($1)
       AND p.oid NOT IN (SELECT objid FROM members)
    UNION ALL
    SELECT 3, format('DROP %s IF EXISTS %I.%I CASCADE',
             CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, n.nspname, t.typname),
           n.nspname || '.' || t.typname
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = ANY($1)
       AND t.typtype IN ('e', 'd', 'r', 'm', 'c')
       AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       AND t.oid NOT IN (SELECT objid FROM members)
  ) s
  ORDER BY phase, sort_key
`

/**
 * Put back the captured dependents the restore did not recreate itself.
 *
 * A storage policy may well be in the snapshot's storage-policies layer and
 * already be back; creating it again would fail. So each is checked first.
 */
export async function recreateExternalDependents(
  client: pg.Client,
  dependents: ExternalDependent[],
): Promise<ExternalDependent[]> {
  const recreated: ExternalDependent[] = []

  for (const dep of dependents) {
    const exists = dep.kind === 'trigger'
      ? `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`
      : `SELECT 1 FROM pg_policies WHERE schemaname = $1 AND tablename = $2 AND policyname = $3`
    const { rows } = await client.query(exists, [dep.schema, dep.table, dep.name])
    if (rows.length > 0) continue

    await client.query(dep.ddl)
    recreated.push(dep)
  }

  return recreated
}
