import type { QueryFn } from '../db.js'
import { pgQuery } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { Check, type CheckContext } from './base.js'
import { SUPABASE_PLATFORM_SCHEMAS } from '../defaults.js'

interface PgRole {
  rolname: string
  rolsuper: boolean
  rolinherit: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolcanlogin: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolconnlimit: number
  rolvaliduntil: string | null
}

interface RoleGrant {
  grantee: string
  table_schema: string
  table_name: string
  privilege_type: string
  is_grantable: boolean
  /** Set for a column-level grant, `GRANT UPDATE (col) ON t TO r`. */
  column_name?: string | null
}

/**
 * Roles the platform owns outright.
 *
 * Their attributes and their grants are Supabase's to manage, and a difference
 * in either means the two projects run different Supabase versions rather than
 * that anybody changed anything.
 */
const PLATFORM_ROLES = [
  'postgres', 'supabase_admin', 'authenticator',
  'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user',
  'pgbouncer', 'supavisor',
]

/**
 * The roles the Data API authenticates as.
 *
 * Their *attributes* are Supabase's — nobody usefully diffs whether `anon` can
 * log in — but their *table grants* are the application's, and are exactly the
 * drift worth catching: `REVOKE ALL ON public.plans FROM anon` is the
 * difference between a table being readable through the anon key and not
 * (issue #90). All three were filtered out of the grants query, so that change
 * reported clean.
 */
const API_ROLES = ['anon', 'authenticated', 'service_role']

const quoted = (names: string[]) => names.map(n => `'${n.replace(/'/g, "''")}'`).join(', ')

const ROLES_SQL = `
  SELECT
    rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit,
    rolvaliduntil::text AS rolvaliduntil
  FROM pg_roles
  WHERE NOT (rolname LIKE 'pg_%')
    AND rolname NOT IN (${quoted([...PLATFORM_ROLES, ...API_ROLES])})
  ORDER BY rolname
`

/**
 * Schemas whose grants are compared: everything but Supabase's own.
 *
 * Grants on `storage.objects`, `realtime.messages` or `vault.secrets` are set by
 * Supabase and move with its version. Comparing them reported one project's
 * Supabase upgrade as drift in the other — and offered `REVOKE ... ON
 * storage.objects FROM anon` as the fix, which breaks Storage. On a test stack
 * two thirds of the grants the Data API roles hold were in these schemas.
 */
function grantSchemaFilter(ignoreSchemas: string[]): string {
  const excluded = [...new Set([...SUPABASE_PLATFORM_SCHEMAS, ...ignoreSchemas])]
  return `NOT IN (${quoted(excluded)})`
}

const grantsSql = (ignoreSchemas: string[]) => `
  SELECT grantee, table_schema, table_name, privilege_type,
         (is_grantable = 'YES') AS is_grantable
  FROM information_schema.role_table_grants
  WHERE grantee NOT IN (${quoted(PLATFORM_ROLES)})
    AND grantee NOT LIKE 'pg_%'
    AND table_schema ${grantSchemaFilter(ignoreSchemas)}
  ORDER BY grantee, table_schema, table_name, privilege_type
`

/**
 * Column-level grants, read from `attacl`.
 *
 * `information_schema.column_privileges` also lists every column a table-level
 * grant covers, which would report each table grant once per column. The
 * attribute ACL holds only what was granted on the column itself —
 * `GRANT UPDATE (display_name) ON profiles TO authenticated`, the usual way to
 * let a user edit some columns of their row and not others.
 */
const columnGrantsSql = (ignoreSchemas: string[]) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         n.nspname AS table_schema, c.relname AS table_name, att.attname AS column_name,
         a.privilege_type, a.is_grantable
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE att.attacl IS NOT NULL AND att.attnum > 0 AND NOT att.attisdropped
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.grantee <> c.relowner
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (${quoted(PLATFORM_ROLES)}))
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg_%')
  ORDER BY 1, 2, 3, 4, 5
`

export class RolesCheck extends Check {
  readonly name = 'roles' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const ignore = ctx.config.ignoreSchemas ?? []
    const [sourceRoles, targetRoles, sourceGrants, targetGrants, sourceColumns, targetColumns] = await Promise.all([
      this.queryFn(ctx.source.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.target.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.source.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.source.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
    ])

    return [
      ...diffRoles(sourceRoles, targetRoles),
      ...diffGrants(
        [...(sourceGrants ?? []), ...(sourceColumns ?? [])],
        [...(targetGrants ?? []), ...(targetColumns ?? [])],
      ),
    ]
  }
}

function roleAttrs(r: PgRole): string {
  const attrs: string[] = []
  if (r.rolsuper) attrs.push('SUPERUSER')
  if (r.rolinherit) attrs.push('INHERIT')
  if (r.rolcreaterole) attrs.push('CREATEROLE')
  if (r.rolcreatedb) attrs.push('CREATEDB')
  if (r.rolcanlogin) attrs.push('LOGIN')
  if (r.rolreplication) attrs.push('REPLICATION')
  if (r.rolbypassrls) attrs.push('BYPASSRLS')
  if (r.rolconnlimit >= 0) attrs.push(`CONNECTION LIMIT ${r.rolconnlimit}`)
  if (r.rolvaliduntil) attrs.push(`VALID UNTIL '${r.rolvaliduntil}'`)
  return attrs.length > 0 ? attrs.join(' ') : 'NOLOGIN'
}

function rolesEqual(a: PgRole, b: PgRole): boolean {
  return (
    a.rolsuper === b.rolsuper &&
    a.rolinherit === b.rolinherit &&
    a.rolcreaterole === b.rolcreaterole &&
    a.rolcreatedb === b.rolcreatedb &&
    a.rolcanlogin === b.rolcanlogin &&
    a.rolreplication === b.rolreplication &&
    a.rolbypassrls === b.rolbypassrls &&
    a.rolconnlimit === b.rolconnlimit &&
    a.rolvaliduntil === b.rolvaliduntil
  )
}

export function diffRoles(source: PgRole[], target: PgRole[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(r => [r.rolname, r]))
  const targetMap = new Map(target.map(r => [r.rolname, r]))

  for (const [name, sr] of sourceMap) {
    if (!targetMap.has(name)) {
      issues.push({
        id: `roles-missing-${name}`,
        check: 'roles',
        severity: 'critical',
        title: `Missing role: ${name}`,
        description: `Role "${name}" exists in source but is missing from target. Any RLS policies or grants referencing this role will be silently ineffective.`,
        sourceValue: sr,
        sql: {
          up: `CREATE ROLE "${name}" ${roleAttrs(sr)};`,
          down: `DROP ROLE IF EXISTS "${name}";`,
        },
      })
    }
  }

  for (const [name, tr] of targetMap) {
    if (!sourceMap.has(name)) {
      issues.push({
        id: `roles-extra-${name}`,
        check: 'roles',
        severity: 'warning',
        title: `Extra role: ${name}`,
        description: `Role "${name}" exists in target but not in source.`,
        targetValue: tr,
        sql: {
          up: `DROP ROLE IF EXISTS "${name}";`,
          down: `CREATE ROLE "${name}" ${roleAttrs(tr)};`,
        },
      })
    }
  }

  for (const [name, sr] of sourceMap) {
    const tr = targetMap.get(name)
    if (tr && !rolesEqual(sr, tr)) {
      issues.push({
        id: `roles-modified-${name}`,
        check: 'roles',
        severity: 'warning',
        title: `Modified role: ${name}`,
        description: `Role "${name}" has different attributes between source and target.`,
        sourceValue: sr,
        targetValue: tr,
        sql: {
          up: `ALTER ROLE "${name}" ${roleAttrs(sr)};`,
          down: `ALTER ROLE "${name}" ${roleAttrs(tr)};`,
        },
      })
    }
  }

  return issues
}

function grantKey(g: RoleGrant): string {
  const column = g.column_name ? `.${g.column_name}` : ''
  return `${g.grantee}.${g.table_schema}.${g.table_name}${column}.${g.privilege_type}`
}

/**
 * A grantee as SQL. `PUBLIC` is a keyword, not a role: quoted, it names a
 * role called "PUBLIC", which does not exist, so the fix failed.
 */
function granteeSql(grantee: string): string {
  return grantee === 'PUBLIC' ? 'PUBLIC' : `"${grantee.replace(/"/g, '""')}"`
}

/** `SELECT ON "s"."t"`, or `UPDATE ("col") ON "s"."t"` for a column grant. */
function grantTarget(g: RoleGrant): string {
  const column = g.column_name ? ` ("${g.column_name.replace(/"/g, '""')}")` : ''
  return `${g.privilege_type}${column} ON "${g.table_schema}"."${g.table_name}"`
}

function describeGrant(g: RoleGrant): string {
  const column = g.column_name ? `(${g.column_name}) ` : ''
  return `${g.privilege_type} ${column}ON ${g.table_schema}.${g.table_name} TO ${g.grantee}`
}

const grantSql = (g: RoleGrant, withOption = g.is_grantable) =>
  `GRANT ${grantTarget(g)} TO ${granteeSql(g.grantee)}${withOption ? ' WITH GRANT OPTION' : ''};`
const revokeSql = (g: RoleGrant) => `REVOKE ${grantTarget(g)} FROM ${granteeSql(g.grantee)};`

export function diffGrants(source: RoleGrant[], target: RoleGrant[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(g => [grantKey(g), g]))
  const targetMap = new Map(target.map(g => [grantKey(g), g]))

  for (const [key, sg] of sourceMap) {
    const tg = targetMap.get(key)
    if (!tg) {
      issues.push({
        id: `roles-grant-missing-${key}`,
        check: 'roles',
        severity: 'warning',
        title: `Missing grant: ${describeGrant(sg)}`,
        description: `Grant "${describeGrant(sg)}" is missing from target.`,
        sourceValue: sg,
        sql: { up: grantSql(sg), down: revokeSql(sg) },
      })
    } else if (Boolean(sg.is_grantable) !== Boolean(tg.is_grantable)) {
      // The same privilege, held with the grant option on one side only.
      // Keying on the privilege alone reported these identical; the grant
      // option is what lets the grantee pass the privilege on.
      const revokeOption = `REVOKE GRANT OPTION FOR ${grantTarget(sg)} FROM ${granteeSql(sg.grantee)};`
      issues.push({
        id: `roles-grant-option-${key}`,
        check: 'roles',
        severity: 'warning',
        title: `Grant option differs: ${describeGrant(sg)}`,
        description: `"${describeGrant(sg)}" is held ${sg.is_grantable ? 'with' : 'without'} the grant option in source `
          + `and ${tg.is_grantable ? 'with' : 'without'} it in target.`,
        sourceValue: sg,
        targetValue: tg,
        sql: sg.is_grantable
          ? { up: grantSql(sg, true), down: revokeOption }
          : { up: revokeOption, down: grantSql(tg, true) },
      })
    }
  }

  for (const [key, tg] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `roles-grant-extra-${key}`,
        check: 'roles',
        severity: 'info',
        title: `Extra grant: ${describeGrant(tg)}`,
        description: `Grant "${describeGrant(tg)}" exists in target but not in source.`,
        targetValue: tg,
        sql: { up: revokeSql(tg), down: grantSql(tg) },
      })
    }
  }

  return issues
}
