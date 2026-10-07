/**
 * RLS policy comparison for a single, named schema.
 *
 * Supabase's own schemas are excluded from the main RLS layer because their
 * tables are product-managed — differences there mean the two projects run
 * different Supabase versions, not that anyone changed anything. But a few of
 * those tables carry policies the *user* writes:
 *
 *   storage.objects   — who may read or write which files
 *   realtime.messages — who may join which channel (Realtime Authorization)
 *
 * Those are security rules, and they drift like any other. This module lets a
 * check compare policies inside one ignored schema without reopening the whole
 * schema to the RLS layer.
 */
import type { CheckName, DriftIssue } from '../types/drift'
import { normalizeRoles } from './strings'
import { quoteLiteral, quoteName } from './sql'

export interface SchemaPolicy {
  tablename: string
  policyname: string
  permissive: string
  roles: string[] | string
  cmd: string
  qual: string | null
  with_check: string | null
  /** `COMMENT ON POLICY`, which pg_policies does not carry. */
  comment?: string | null
}

/** Policies on one schema. Parameterised rather than interpolated by callers. */
export function schemaPolicySql(schema: string): string {
  return `
    SELECT tablename, policyname, permissive, roles, cmd, qual, with_check,
      (SELECT obj_description(p.oid, 'pg_policy') FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = pg_policies.schemaname AND c.relname = pg_policies.tablename
          AND p.polname = pg_policies.policyname) AS comment
    FROM pg_policies
    WHERE schemaname = '${schema}'
    ORDER BY tablename, policyname
  `
}

export function policyKey(p: SchemaPolicy): string {
  return `${p.tablename}.${p.policyname}`
}

/** `"schema"."table"`, each part quoted with its own quotes doubled. */
const policyTable = (schema: string, p: Pick<SchemaPolicy, 'tablename'>) => `${quoteName(schema)}.${quoteName(p.tablename)}`

/**
 * A role in a policy's TO list. pg_policies spells the PUBLIC pseudo-role
 * `public`, which quoted would name a role that does not exist.
 */
const roleSql = (role: string) => role === 'public' ? 'PUBLIC' : quoteName(role)

/**
 * The SQL for a policy, used by every check and snapshot layer that writes one,
 * so a name is quoted the same way everywhere. A policy named `say "hi"
 * there`, written between plain quotes, was a syntax error that rolled back a
 * whole restore or apply.
 */
export function createPolicySql(schema: string, p: SchemaPolicy): string {
  const roles = normalizeRoles(p.roles).map(roleSql).join(', ')
  const lines = [
    `CREATE POLICY ${quoteName(p.policyname)}`,
    `  ON ${policyTable(schema, p)}`,
    `  AS ${p.permissive}`,
    `  FOR ${p.cmd}`,
    `  TO ${roles}`,
  ]
  if (p.qual) lines.push(`  USING (${p.qual})`)
  if (p.with_check) lines.push(`  WITH CHECK (${p.with_check})`)
  lines.push(';')
  // With the policy, since recreating one takes its comment with it.
  if (p.comment) lines.push(commentPolicySql(schema, p))
  return lines.join('\n')
}

export function commentPolicySql(schema: string, p: SchemaPolicy): string {
  return `COMMENT ON POLICY ${quoteName(p.policyname)} ON ${policyTable(schema, p)} IS ${p.comment ? quoteLiteral(p.comment) : 'NULL'};`
}

export function dropPolicySql(schema: string, p: SchemaPolicy): string {
  return `DROP POLICY IF EXISTS ${quoteName(p.policyname)} ON ${policyTable(schema, p)};`
}

export function policiesEqual(a: SchemaPolicy, b: SchemaPolicy): boolean {
  return a.permissive === b.permissive
    && a.cmd === b.cmd
    && a.qual === b.qual
    && a.with_check === b.with_check
    && normalizeRoles(a.roles).join(',') === normalizeRoles(b.roles).join(',')
}

export interface PolicyDiffOptions {
  /** Schema the policies live in, e.g. 'storage'. */
  schema: string
  /** Which check owns the resulting issues. */
  check: CheckName
  /** Issue id prefix, e.g. 'storage-policy'. Kept stable across refactors. */
  idPrefix: string
  /**
   * Human label, lower-case: used verbatim in titles ("Missing storage
   * policy") and capitalised at the start of descriptions ("Storage RLS
   * policy ..."). Kept exactly as the messages read before this was shared, so
   * a refactor does not quietly reword output users may be matching on.
   */
  label: string
}

/**
 * Compare policies between two environments.
 *
 * A missing or altered policy is critical: both mean the target enforces
 * something different from the source, and for these schemas that is an access
 * rule. An extra policy is info — it may be deliberate, and removing it is a
 * judgement the operator should make rather than a fix to apply blindly.
 */
export function diffSchemaPolicies(
  source: SchemaPolicy[],
  target: SchemaPolicy[],
  opts: PolicyDiffOptions,
): DriftIssue[] {
  const { schema, check, idPrefix, label } = opts
  const Label = label.charAt(0).toUpperCase() + label.slice(1)
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(p => [policyKey(p), p]))
  const targetMap = new Map(target.map(p => [policyKey(p), p]))

  for (const [key, sp] of sourceMap) {
    if (targetMap.has(key)) continue
    issues.push({
      id: `${idPrefix}-missing-${key}`,
      check,
      severity: 'critical',
      title: `Missing ${label} policy: ${sp.policyname} on ${sp.tablename}`,
      description: `${Label} RLS policy "${sp.policyname}" on ${schema}.${sp.tablename} exists in source but not in target.`,
      sourceValue: sp,
      sql: {
        up: createPolicySql(schema, sp),
        down: dropPolicySql(schema, sp),
      },
    })
  }

  for (const [key, tp] of targetMap) {
    if (sourceMap.has(key)) continue
    issues.push({
      id: `${idPrefix}-extra-${key}`,
      check,
      severity: 'info',
      title: `Extra ${label} policy: ${tp.policyname} on ${tp.tablename}`,
      description: `${Label} RLS policy "${tp.policyname}" on ${schema}.${tp.tablename} exists in target but not in source.`,
      targetValue: tp,
      sql: {
        up: dropPolicySql(schema, tp),
        down: createPolicySql(schema, tp),
      },
    })
  }

  for (const [key, sp] of sourceMap) {
    const tp = targetMap.get(key)
    if (!tp || policiesEqual(sp, tp)) continue
    issues.push({
      id: `${idPrefix}-changed-${key}`,
      check,
      severity: 'critical',
      title: `${Label} policy changed: ${sp.policyname} on ${sp.tablename}`,
      description: `${Label} RLS policy "${sp.policyname}" on ${schema}.${sp.tablename} differs between source and target.`,
      sourceValue: sp,
      targetValue: tp,
      sql: {
        up: [dropPolicySql(schema, sp), createPolicySql(schema, sp)].join('\n'),
        down: [dropPolicySql(schema, tp), createPolicySql(schema, tp)].join('\n'),
      },
    })
  }

  // A comment is reported on its own, not as a changed policy: it needs no
  // drop and recreate, and a policy whose expressions differ only in how they
  // are written is filtered out as unchanged — which would take a real comment
  // difference with it.
  for (const [key, sp] of sourceMap) {
    const tp = targetMap.get(key)
    if (!tp || (sp.comment ?? null) === (tp.comment ?? null)) continue
    issues.push({
      id: `${idPrefix}-comment-${key}`,
      check,
      severity: 'info',
      title: `${Label} policy comment changed: ${sp.policyname} on ${sp.tablename}`,
      description: `The comment on ${label} RLS policy "${sp.policyname}" on ${schema}.${sp.tablename} differs between source and target.`,
      sourceValue: sp.comment ?? null,
      targetValue: tp.comment ?? null,
      sql: {
        up: commentPolicySql(schema, sp),
        down: commentPolicySql(schema, tp),
      },
    })
  }

  return issues
}
