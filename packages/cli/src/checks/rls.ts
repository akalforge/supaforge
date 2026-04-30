import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { normalizeRoles } from '../utils/strings'
import { Check, type CheckContext } from './base'

interface RlsPolicy {
  schemaname: string
  tablename: string
  policyname: string
  permissive: string
  roles: string[]
  cmd: string
  qual: string | null
  with_check: string | null
}

interface RlsTableStatus {
  schemaname: string
  tablename: string
  rls_enabled: boolean
}

export class RlsCheck extends Check {
  readonly name = 'rls' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const ignoreSchemas = ctx.config.ignoreSchemas ?? []
    const [sourcePolicies, targetPolicies, sourceStatus, targetStatus] = await Promise.all([
      this.fetchPolicies(ctx.source.dbUrl, ignoreSchemas),
      this.fetchPolicies(ctx.target.dbUrl, ignoreSchemas),
      this.fetchTableRlsStatus(ctx.source.dbUrl, ignoreSchemas),
      this.fetchTableRlsStatus(ctx.target.dbUrl, ignoreSchemas),
    ])
    // RLS status issues come first so ENABLE runs before CREATE POLICY when applying
    return [
      ...diffRlsStatus(sourceStatus, targetStatus),
      ...diffPolicies(sourcePolicies, targetPolicies),
    ]
  }

  private async fetchPolicies(dbUrl: string, ignoreSchemas: string[]): Promise<RlsPolicy[]> {
    if (ignoreSchemas.length === 0) {
      return await this.queryFn(dbUrl, POLICY_SQL_NO_FILTER) as unknown as RlsPolicy[]
    }
    const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
    const sql = `
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname NOT IN (${placeholders})
      ORDER BY schemaname, tablename, policyname
    `
    return await this.queryFn(dbUrl, sql, ignoreSchemas) as unknown as RlsPolicy[]
  }

  private async fetchTableRlsStatus(dbUrl: string, ignoreSchemas: string[]): Promise<RlsTableStatus[]> {
    if (ignoreSchemas.length === 0) {
      return await this.queryFn(dbUrl, RLS_STATUS_SQL_NO_FILTER) as unknown as RlsTableStatus[]
    }
    const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
    const sql = `
      SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
      AND n.nspname NOT IN (${placeholders})
      ORDER BY n.nspname, c.relname
    `
    return await this.queryFn(dbUrl, sql, ignoreSchemas) as unknown as RlsTableStatus[]
  }
}

const POLICY_SQL_NO_FILTER = `
  SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  ORDER BY schemaname, tablename, policyname
`

const RLS_STATUS_SQL_NO_FILTER = `
  SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rls_enabled
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
  ORDER BY n.nspname, c.relname
`

function policyKey(p: RlsPolicy): string {
  return `${p.schemaname}.${p.tablename}.${p.policyname}`
}

function policiesEqual(a: RlsPolicy, b: RlsPolicy): boolean {
  return (
    a.permissive === b.permissive &&
    a.cmd === b.cmd &&
    a.qual === b.qual &&
    a.with_check === b.with_check &&
    JSON.stringify(a.roles) === JSON.stringify(b.roles)
  )
}

/** Parse pg name[] which may arrive as JS array or Postgres literal {a,b} */

function generateCreatePolicySql(p: RlsPolicy): string {
  const roles = normalizeRoles(p.roles).join(', ')
  const lines = [
    `CREATE POLICY "${p.policyname}"`,
    `  ON "${p.schemaname}"."${p.tablename}"`,
    `  AS ${p.permissive}`,
    `  FOR ${p.cmd}`,
    `  TO ${roles}`,
  ]
  if (p.qual) lines.push(`  USING (${p.qual})`)
  if (p.with_check) lines.push(`  WITH CHECK (${p.with_check})`)
  lines.push(';')
  return lines.join('\n')
}

function generateDropPolicySql(p: RlsPolicy): string {
  return `DROP POLICY IF EXISTS "${p.policyname}" ON "${p.schemaname}"."${p.tablename}";`
}

export function diffPolicies(source: RlsPolicy[], target: RlsPolicy[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(p => [policyKey(p), p]))
  const targetMap = new Map(target.map(p => [policyKey(p), p]))

  // Missing in target — CVE-2025-48757 risk pattern
  for (const [key, p] of sourceMap) {
    if (!targetMap.has(key)) {
      issues.push({
        id: `rls-missing-${key}`,
        check: 'rls',
        severity: 'critical',
        title: `Missing RLS policy: ${p.policyname}`,
        description: `Policy "${p.policyname}" on ${p.schemaname}.${p.tablename} exists in source but is missing from target. This is a CVE-2025-48757 risk pattern.`,
        sourceValue: p,
        sql: {
          up: generateCreatePolicySql(p),
          down: generateDropPolicySql(p),
        },
      })
    }
  }

  // Extra in target
  for (const [key, p] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `rls-extra-${key}`,
        check: 'rls',
        severity: 'warning',
        title: `Extra RLS policy: ${p.policyname}`,
        description: `Policy "${p.policyname}" on ${p.schemaname}.${p.tablename} exists in target but not in source.`,
        targetValue: p,
        sql: {
          up: generateDropPolicySql(p),
          down: generateCreatePolicySql(p),
        },
      })
    }
  }

  // Modified policies
  for (const [key, sp] of sourceMap) {
    const tp = targetMap.get(key)
    if (tp && !policiesEqual(sp, tp)) {
      issues.push({
        id: `rls-modified-${key}`,
        check: 'rls',
        severity: 'critical',
        title: `Modified RLS policy: ${sp.policyname}`,
        description: `Policy "${sp.policyname}" on ${sp.schemaname}.${sp.tablename} has different USING/WITH CHECK expressions between source and target.`,
        sourceValue: sp,
        targetValue: tp,
        sql: {
          up: [generateDropPolicySql(sp), generateCreatePolicySql(sp)].join('\n'),
          down: [generateDropPolicySql(tp), generateCreatePolicySql(tp)].join('\n'),
        },
      })
    }
  }

  return issues
}

/**
 * Compare RLS enabled/disabled status for tables that exist in both environments.
 *
 * Generates a critical issue when source has RLS enabled but target does not —
 * any policies on that table are silently inactive until RLS is turned on.
 */
export function diffRlsStatus(
  source: { schemaname: string; tablename: string; rls_enabled: boolean }[],
  target: { schemaname: string; tablename: string; rls_enabled: boolean }[],
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const targetMap = new Map(target.map(t => [`${t.schemaname}.${t.tablename}`, t]))

  for (const src of source) {
    const key = `${src.schemaname}.${src.tablename}`
    const tgt = targetMap.get(key)
    // Table absent from target — schema drift handles creation, skip here
    if (!tgt) continue

    if (src.rls_enabled && !tgt.rls_enabled) {
      issues.push({
        id: `rls-disabled-${key}`,
        check: 'rls',
        severity: 'critical',
        title: `RLS not enabled: ${src.schemaname}.${src.tablename}`,
        description: `Row Level Security is enabled on "${src.schemaname}"."${src.tablename}" in source but disabled in target. Any policies on this table have no effect until RLS is enabled.`,
        sourceValue: src,
        targetValue: tgt,
        sql: {
          up: `ALTER TABLE "${src.schemaname}"."${src.tablename}" ENABLE ROW LEVEL SECURITY;`,
          down: `ALTER TABLE "${src.schemaname}"."${src.tablename}" DISABLE ROW LEVEL SECURITY;`,
        },
      })
    } else if (!src.rls_enabled && tgt.rls_enabled) {
      issues.push({
        id: `rls-enabled-${key}`,
        check: 'rls',
        severity: 'warning',
        title: `RLS enabled unexpectedly: ${src.schemaname}.${src.tablename}`,
        description: `Row Level Security is disabled on "${src.schemaname}"."${src.tablename}" in source but enabled in target.`,
        sourceValue: src,
        targetValue: tgt,
        sql: {
          up: `ALTER TABLE "${src.schemaname}"."${src.tablename}" DISABLE ROW LEVEL SECURITY;`,
          down: `ALTER TABLE "${src.schemaname}"."${src.tablename}" ENABLE ROW LEVEL SECURITY;`,
        },
      })
    }
  }

  return issues
}
