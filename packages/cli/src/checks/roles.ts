import type { QueryFn } from '../db.js'
import { pgQuery } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { Check, type CheckContext } from './base.js'

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
}

const ROLES_SQL = `
  SELECT
    rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit,
    rolvaliduntil::text AS rolvaliduntil
  FROM pg_roles
  WHERE NOT (rolname LIKE 'pg_%')
    AND rolname NOT IN (
      'postgres','supabase_admin','authenticator','service_role',
      'supabase_auth_admin','supabase_storage_admin','dashboard_user',
      'anon','authenticated','pgbouncer','supavisor'
    )
  ORDER BY rolname
`

const GRANTS_SQL = `
  SELECT grantee, table_schema, table_name, privilege_type,
         (is_grantable = 'YES') AS is_grantable
  FROM information_schema.role_table_grants
  WHERE grantee NOT IN (
    'postgres','supabase_admin','authenticator','service_role',
    'supabase_auth_admin','supabase_storage_admin','dashboard_user',
    'anon','authenticated','pgbouncer','supavisor'
  )
    AND grantee NOT LIKE 'pg_%'
  ORDER BY grantee, table_schema, table_name, privilege_type
`

export class RolesCheck extends Check {
  readonly name = 'roles' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [sourceRoles, targetRoles, sourceGrants, targetGrants] = await Promise.all([
      this.queryFn(ctx.source.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.target.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.source.dbUrl, GRANTS_SQL) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, GRANTS_SQL) as unknown as Promise<RoleGrant[]>,
    ])

    return [
      ...diffRoles(sourceRoles as unknown as PgRole[], targetRoles as unknown as PgRole[]),
      ...diffGrants(sourceGrants as unknown as RoleGrant[], targetGrants as unknown as RoleGrant[]),
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
  return `${g.grantee}.${g.table_schema}.${g.table_name}.${g.privilege_type}`
}

export function diffGrants(source: RoleGrant[], target: RoleGrant[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(g => [grantKey(g), g]))
  const targetMap = new Map(target.map(g => [grantKey(g), g]))

  for (const [key, sg] of sourceMap) {
    if (!targetMap.has(key)) {
      issues.push({
        id: `roles-grant-missing-${key}`,
        check: 'roles',
        severity: 'warning',
        title: `Missing grant: ${sg.privilege_type} ON ${sg.table_schema}.${sg.table_name} TO ${sg.grantee}`,
        description: `Grant "${sg.privilege_type} ON ${sg.table_schema}.${sg.table_name}" for role "${sg.grantee}" is missing from target.`,
        sourceValue: sg,
        sql: {
          up: `GRANT ${sg.privilege_type} ON "${sg.table_schema}"."${sg.table_name}" TO "${sg.grantee}";`,
          down: `REVOKE ${sg.privilege_type} ON "${sg.table_schema}"."${sg.table_name}" FROM "${sg.grantee}";`,
        },
      })
    }
  }

  for (const [key, tg] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `roles-grant-extra-${key}`,
        check: 'roles',
        severity: 'info',
        title: `Extra grant: ${tg.privilege_type} ON ${tg.table_schema}.${tg.table_name} TO ${tg.grantee}`,
        description: `Grant "${tg.privilege_type} ON ${tg.table_schema}.${tg.table_name}" for role "${tg.grantee}" exists in target but not in source.`,
        targetValue: tg,
        sql: {
          up: `REVOKE ${tg.privilege_type} ON "${tg.table_schema}"."${tg.table_name}" FROM "${tg.grantee}";`,
          down: `GRANT ${tg.privilege_type} ON "${tg.table_schema}"."${tg.table_name}" TO "${tg.grantee}";`,
        },
      })
    }
  }

  return issues
}
