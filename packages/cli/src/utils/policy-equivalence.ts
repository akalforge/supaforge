import type { CheckContext } from '../checks/base.js'
import { inRolledBackTransaction, pgQuery, type QueryFn } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { quoteIdent } from './sql.js'

/**
 * The parts of a policy that decide whether two are the same. The RLS, storage
 * and realtime checks all read theirs from pg_policies.
 */
export interface ComparablePolicy {
  schemaname: string
  tablename: string
  policyname: string
  permissive?: string | boolean | null
  cmd?: string | null
  roles?: unknown
  qual: string | null
  with_check: string | null
}

/** A policy's USING and WITH CHECK as the server renders them after one more round trip. */
export type PolicyCanonicalizer = (
  dbUrl: string,
  policy: ComparablePolicy,
) => Promise<{ qual: string | null; with_check: string | null } | null>

/**
 * Re-render a policy's expressions by creating it again on a temporary copy
 * of its table, in a transaction that is always rolled back.
 *
 * PostgreSQL's rendering is not stable across a round trip:
 * `status IN ('draft', 'active')` on a varchar column renders one way as
 * written and another once recreated from that rendering, which is what a
 * dump, a restore or a clone does. Comparing text reported every such policy
 * as a critical "Modified RLS policy" between a project and any copy of it.
 * The second rendering is stable, so re-rendering both sides once and
 * comparing those tells a real change from the same policy printed twice.
 *
 * Null when the policy cannot be recreated there; the caller then keeps the
 * textual comparison, which is what it did before.
 */
export const canonicalPolicyExpressions: PolicyCanonicalizer = async (dbUrl, policy) => {
  try {
    return await inRolledBackTransaction(dbUrl, async client => {
      await client.query(
        `CREATE TEMP TABLE sf_canon (LIKE ${quoteIdent(policy.schemaname)}.${quoteIdent(policy.tablename)})`,
      )
      const command = (policy.cmd ?? 'ALL').toUpperCase()
      await client.query(
        `CREATE POLICY sf_canon_p ON sf_canon FOR ${command}`
        + (policy.qual ? ` USING (${policy.qual})` : '')
        + (policy.with_check ? ` WITH CHECK (${policy.with_check})` : ''),
      )
      const { rows } = await client.query<{ qual: string | null; with_check: string | null }>(
        `SELECT pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS with_check
           FROM pg_policy WHERE polrelid = 'pg_temp.sf_canon'::regclass`,
      )
      return rows[0] ?? null
    })
  } catch {
    return null
  }
}

/** The real canonicalizer on the real query path; none for an injected one (tests). */
export function defaultCanonicalizer(queryFn: QueryFn): PolicyCanonicalizer {
  return queryFn === pgQuery ? canonicalPolicyExpressions : async () => null
}

/**
 * Drop the "modified policy" findings whose two sides are the same policy.
 *
 * Only a finding carrying both sides, whose command, mode and roles already
 * match — so only the rendering of its expressions can differ — is checked.
 */
export async function dropEquivalentPolicyChanges(
  issues: DriftIssue[],
  ctx: CheckContext,
  canonicalize: PolicyCanonicalizer,
  /** For checks scoped to one schema, whose rows do not name it. */
  schema?: string,
): Promise<DriftIssue[]> {
  const withSchema = (p: unknown) =>
    p && typeof p === 'object' ? { schemaname: schema, ...(p as object) } as ComparablePolicy : undefined
  const kept: DriftIssue[] = []
  for (const issue of issues) {
    const source = withSchema(issue.sourceValue)
    const target = withSchema(issue.targetValue)
    if (!isPolicy(source) || !isPolicy(target) || !sameApartFromExpressions(source, target)) {
      kept.push(issue)
      continue
    }
    const [a, b] = await Promise.all([
      canonicalize(ctx.source.dbUrl, source),
      canonicalize(ctx.target.dbUrl, target),
    ])
    if (a && b && a.qual === b.qual && a.with_check === b.with_check) continue
    kept.push(issue)
  }
  return kept
}

function isPolicy(p: ComparablePolicy | undefined): p is ComparablePolicy {
  return !!p && typeof p.schemaname === 'string' && typeof p.policyname === 'string'
    && typeof p.tablename === 'string' && 'qual' in p
}

function sameApartFromExpressions(a: ComparablePolicy, b: ComparablePolicy): boolean {
  return a.schemaname === b.schemaname
    && a.tablename === b.tablename
    && a.policyname === b.policyname
    && String(a.permissive) === String(b.permissive)
    && (a.cmd ?? null) === (b.cmd ?? null)
    && JSON.stringify(a.roles) === JSON.stringify(b.roles)
    && (a.qual !== b.qual || a.with_check !== b.with_check)
}
