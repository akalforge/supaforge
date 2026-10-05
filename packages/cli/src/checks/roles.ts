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
  // Created by Supabase's own images for Edge Functions, Realtime, read
  // replicas and logical replication. Diffing a project against plain
  // PostgreSQL offered to create all four on the target.
  'supabase_functions_admin', 'supabase_realtime_admin',
  'supabase_read_only_user', 'supabase_replication_admin',
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

/**
 * Every role but the platform's, the built-in ones, and the one this check is
 * connected as.
 *
 * The connecting role is the credential each environment was given, not part
 * of the project: two databases reached as different users reported each user
 * as drift, and the fix for the target's was `DROP ROLE` on the very role the
 * apply was running as.
 */
const ROLES_SQL = `
  SELECT
    rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit,
    rolvaliduntil::text AS rolvaliduntil
  FROM pg_roles
  WHERE NOT (rolname LIKE 'pg_%')
    AND rolname NOT IN (${quoted([...PLATFORM_ROLES, ...API_ROLES])})
    AND rolname <> current_user
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

/**
 * Table-level grants, read from `relacl` like the column grants below.
 *
 * `information_schema.role_table_grants` was read instead, and it is wrong
 * twice over for a comparison. It includes the owner's own privileges, which
 * are not grants: a table owned by `postgres` on one side and by another user
 * on the other reported every privilege of both owners as drift — 35 findings
 * for a project restored into plain PostgreSQL. And it lists only grants the
 * connecting role takes part in, so a grant between two other roles was not
 * seen at all.
 */
const grantsSql = (ignoreSchemas: string[]) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         n.nspname AS table_schema, c.relname AS table_name,
         a.privilege_type, a.is_grantable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relacl IS NOT NULL
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.grantee <> c.relowner
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (${quoted(PLATFORM_ROLES)}))
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg_%')
  ORDER BY 1, 2, 3, 4
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
    const version = async (url: string) =>
      Number((await this.queryFn(url, `SELECT current_setting('server_version_num') AS v`) as Array<{ v: string }>)[0]?.v ?? 0)
    const [sourceRoles, targetRoles, sourceGrants, targetGrants, sourceColumns, targetColumns, sourceVersion, targetVersion] = await Promise.all([
      this.queryFn(ctx.source.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.target.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.source.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.source.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      version(ctx.source.dbUrl),
      version(ctx.target.dbUrl),
    ])
    const comparable = comparablePrivileges(sourceVersion, targetVersion)

    return [
      ...diffRoles(sourceRoles, targetRoles),
      ...diffGrants(
        [...(sourceGrants ?? []), ...(sourceColumns ?? [])].filter(comparable),
        [...(targetGrants ?? []), ...(targetColumns ?? [])].filter(comparable),
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

/**
 * The grants both servers can hold. MAINTAIN is a PostgreSQL 17 privilege:
 * a 17 source reported it missing from a 15 target, and the fix failed with
 * `unrecognized privilege type "maintain"`, rolling back every grant with it.
 */
export function comparablePrivileges(sourceVersion: number, targetVersion: number): (g: RoleGrant) => boolean {
  const both = Math.min(sourceVersion || Infinity, targetVersion || Infinity)
  return g => g.privilege_type !== 'MAINTAIN' || both >= 170000
}

/** Grants that differ the same way, on one table (or column) to one role, as one finding. */
function grouped(grants: RoleGrant[]): RoleGrant[][] {
  const groups = new Map<string, RoleGrant[]>()
  for (const g of grants) {
    const key = `${g.grantee}.${g.table_schema}.${g.table_name}${g.column_name ? `.${g.column_name}` : ''}.${Boolean(g.is_grantable)}`
    groups.set(key, [...(groups.get(key) ?? []), g])
  }
  return [...groups.values()]
}

/** `SELECT, INSERT ON "s"."t"` for a group of grants on one object. */
function groupTarget(gs: RoleGrant[]): string {
  const column = gs[0].column_name ? ` ("${gs[0].column_name.replace(/"/g, '""')}")` : ''
  return `${gs.map(g => `${g.privilege_type}${column}`).join(', ')} ON "${gs[0].table_schema}"."${gs[0].table_name}"`
}

function describeGroup(gs: RoleGrant[]): string {
  const column = gs[0].column_name ? `(${gs[0].column_name}) ` : ''
  return `${gs.map(g => g.privilege_type).join(', ')} ${column}ON ${gs[0].table_schema}.${gs[0].table_name} TO ${gs[0].grantee}`
}

/** A group's key: the grant key without its privilege. */
const groupKey = (gs: RoleGrant[]) => grantKey(gs[0]).replace(/\.[^.]+$/, '')

/**
 * Grants on the target that differ from the source's.
 *
 * Missing and extra grants are one finding per role, table (or column) and
 * grant option, listing the privileges: one finding per privilege made a
 * table granted to Supabase's three API roles twenty-odd findings, most of a
 * report.
 */
export function diffGrants(source: RoleGrant[], target: RoleGrant[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(g => [grantKey(g), g]))
  const targetMap = new Map(target.map(g => [grantKey(g), g]))

  const missing = [...sourceMap].filter(([key]) => !targetMap.has(key)).map(([, g]) => g)
  for (const gs of grouped(missing)) {
    const plural = gs.length > 1 ? 's' : ''
    issues.push({
      id: `roles-grant-missing-${groupKey(gs)}`,
      check: 'roles',
      severity: 'warning',
      title: `Missing grant${plural}: ${describeGroup(gs)}`,
      description: `Grant${plural} "${describeGroup(gs)}" ${gs.length > 1 ? 'are' : 'is'} missing from target.`,
      sourceValue: gs.length > 1 ? gs : gs[0],
      sql: {
        up: `GRANT ${groupTarget(gs)} TO ${granteeSql(gs[0].grantee)}${gs[0].is_grantable ? ' WITH GRANT OPTION' : ''};`,
        down: `REVOKE ${groupTarget(gs)} FROM ${granteeSql(gs[0].grantee)};`,
      },
    })
  }

  for (const [key, sg] of sourceMap) {
    const tg = targetMap.get(key)
    if (tg && Boolean(sg.is_grantable) !== Boolean(tg.is_grantable)) {
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

  const extra = [...targetMap].filter(([key]) => !sourceMap.has(key)).map(([, g]) => g)
  for (const gs of grouped(extra)) {
    const plural = gs.length > 1 ? 's' : ''
    issues.push({
      id: `roles-grant-extra-${groupKey(gs)}`,
      check: 'roles',
      severity: 'info',
      title: `Extra grant${plural}: ${describeGroup(gs)}`,
      description: `Grant${plural} "${describeGroup(gs)}" exist${gs.length > 1 ? '' : 's'} in target but not in source.`,
      targetValue: gs.length > 1 ? gs : gs[0],
      sql: {
        up: `REVOKE ${groupTarget(gs)} FROM ${granteeSql(gs[0].grantee)};`,
        down: `GRANT ${groupTarget(gs)} TO ${granteeSql(gs[0].grantee)}${gs[0].is_grantable ? ' WITH GRANT OPTION' : ''};`,
      },
    })
  }

  return issues
}
