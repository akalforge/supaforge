import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { quoteName } from '../utils/sql'
import { Check, type CheckContext } from './base'
import {
  diffSchemaPolicies, schemaPolicySql, type SchemaPolicy,
} from '../utils/schema-policies'

interface RealtimePublication {
  pubname: string
  schemaname: string
  tablename: string
}

export class RealtimeCheck extends Check {
  readonly name = 'realtime' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchPublications(ctx.source.dbUrl),
      this.fetchPublications(ctx.target.dbUrl),
    ])
    const publicationIssues = diffPublications(source, target)

    // Realtime Authorization policies live on realtime.messages and decide who
    // may join which channel. They are written by the user, but the realtime
    // schema is excluded from the main RLS layer because its other tables are
    // product-managed — so nothing compared them at all. A policy relaxed from
    // `topic LIKE 'user:%'` to `true` reported no drift.
    const [srcPolicies, tgtPolicies] = await Promise.all([
      this.fetchPolicies(ctx.source.dbUrl),
      this.fetchPolicies(ctx.target.dbUrl),
    ])
    const policyIssues = diffSchemaPolicies(srcPolicies, tgtPolicies, {
      schema: 'realtime',
      check: 'realtime',
      idPrefix: 'realtime-policy',
      label: 'realtime authorization',
    })

    return [...publicationIssues, ...policyIssues]
  }

  private async fetchPolicies(dbUrl: string): Promise<SchemaPolicy[]> {
    try {
      return await this.queryFn(dbUrl, schemaPolicySql('realtime')) as unknown as SchemaPolicy[]
    } catch {
      // No realtime schema at all — nothing to compare.
      return []
    }
  }

  private async fetchPublications(dbUrl: string): Promise<RealtimePublication[]> {
    try {
      return await this.queryFn(dbUrl, PUBLICATION_SQL) as unknown as RealtimePublication[]
    } catch {
      // pg_publication may not be accessible
      return []
    }
  }
}

const PUBLICATION_SQL = `
  SELECT p.pubname, pt.schemaname, pt.tablename
  FROM pg_publication p
  LEFT JOIN pg_publication_tables pt ON p.pubname = pt.pubname
  WHERE p.pubname NOT IN ('supabase_realtime')
  ORDER BY p.pubname, pt.schemaname, pt.tablename
`

/**
 * Supabase uses the `supabase_realtime` publication by default.
 * We separately query its tables for diffing.
 */
const SUPABASE_REALTIME_SQL = `
  SELECT p.pubname, pt.schemaname, pt.tablename
  FROM pg_publication p
  LEFT JOIN pg_publication_tables pt ON p.pubname = pt.pubname
  WHERE p.pubname = 'supabase_realtime'
  ORDER BY pt.schemaname, pt.tablename
`

function pubTableKey(pub: RealtimePublication): string {
  return `${pub.pubname}.${pub.schemaname}.${pub.tablename}`
}

export function diffPublications(source: RealtimePublication[], target: RealtimePublication[]): DriftIssue[] {
  const issues: DriftIssue[] = []

  // Diff publication-level presence
  const sourcePubs = new Set(source.map(p => p.pubname))
  const targetPubs = new Set(target.map(p => p.pubname))

  for (const pubname of sourcePubs) {
    if (!targetPubs.has(pubname)) {
      const tables = source.filter(p => p.pubname === pubname && p.tablename)
      issues.push({
        id: `realtime-missing-pub-${pubname}`,
        check: 'realtime',
        severity: 'warning',
        title: `Missing publication: ${pubname}`,
        description: `Publication "${pubname}" exists in source but not in target.`,
        sourceValue: tables,
        sql: {
          up: `CREATE PUBLICATION ${quoteName(pubname)}${tables.length > 0 ? ` FOR TABLE ${tables.map(t => `${quoteName(t.schemaname)}.${quoteName(t.tablename)}`).join(', ')}` : ''};`,
          down: `DROP PUBLICATION IF EXISTS ${quoteName(pubname)};`,
        },
      })
    }
  }

  for (const pubname of targetPubs) {
    if (!sourcePubs.has(pubname)) {
      issues.push({
        id: `realtime-extra-pub-${pubname}`,
        check: 'realtime',
        severity: 'info',
        title: `Extra publication: ${pubname}`,
        description: `Publication "${pubname}" exists in target but not in source.`,
      })
    }
  }

  // Diff table membership within shared publications
  const sharedPubs = [...sourcePubs].filter(p => targetPubs.has(p))
  for (const pubname of sharedPubs) {
    const sourceTables = new Set(
      source.filter(p => p.pubname === pubname && p.tablename).map(p => `${p.schemaname}.${p.tablename}`),
    )
    const targetTables = new Set(
      target.filter(p => p.pubname === pubname && p.tablename).map(p => `${p.schemaname}.${p.tablename}`),
    )

    for (const fqn of sourceTables) {
      if (!targetTables.has(fqn)) {
        issues.push({
          id: `realtime-missing-table-${pubname}-${fqn}`,
          check: 'realtime',
          severity: 'warning',
          title: `Table not published: ${fqn} in ${pubname}`,
          description: `Table "${fqn}" is published in source publication "${pubname}" but not in target.`,
          sql: {
            up: `ALTER PUBLICATION ${quoteName(pubname)} ADD TABLE ${fqn};`,
            down: `ALTER PUBLICATION ${quoteName(pubname)} DROP TABLE ${fqn};`,
          },
        })
      }
    }

    for (const fqn of targetTables) {
      if (!sourceTables.has(fqn)) {
        issues.push({
          id: `realtime-extra-table-${pubname}-${fqn}`,
          check: 'realtime',
          severity: 'info',
          title: `Extra published table: ${fqn} in ${pubname}`,
          description: `Table "${fqn}" is published in target publication "${pubname}" but not in source.`,
        })
      }
    }
  }

  return issues
}

