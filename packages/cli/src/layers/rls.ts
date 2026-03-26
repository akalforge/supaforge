import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

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

export class RlsLayer extends Layer {
  readonly name = 'rls' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const ignoreSchemas = ctx.config.ignoreSchemas ?? []
    const [source, target] = await Promise.all([
      this.fetchPolicies(ctx.source.dbUrl, ignoreSchemas),
      this.fetchPolicies(ctx.target.dbUrl, ignoreSchemas),
    ])
    return diffPolicies(source, target)
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
}

const POLICY_SQL_NO_FILTER = `
  SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  ORDER BY schemaname, tablename, policyname
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
function normalizeRoles(roles: string[] | string): string {
  if (Array.isArray(roles)) return roles.join(', ')
  if (typeof roles === 'string' && roles.startsWith('{') && roles.endsWith('}')) {
    return roles.slice(1, -1).split(',').join(', ')
  }
  return String(roles)
}

function generateCreatePolicySql(p: RlsPolicy): string {
  const roles = normalizeRoles(p.roles)
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
        layer: 'rls',
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
        layer: 'rls',
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
        layer: 'rls',
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
