/**
 * The same policy rendered twice is not a change, against a real server.
 *
 * `status IN ('draft', 'active')` on a varchar column renders one way as
 * written and another once recreated from that rendering — which is what a
 * dump, a restore or a clone does. The RLS check compared the text and
 * reported a critical "Modified RLS policy" between a project and any copy of
 * it. Both directions are pinned: a rendered copy is equivalent, and a
 * changed list is not.
 */
import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'
import { canonicalPolicyExpressions, dropEquivalentPolicyChanges } from '../../src/utils/policy-equivalence'
import { RlsCheck } from '../../src/checks/rls'
import { closePgPools } from '../../src/db'
import { TARGET_URL, skipIfNoContainers } from './helpers'
import type { CheckContext } from '../../src/checks/base'

const skip = skipIfNoContainers()
const stamp = Date.now()
const dbs: string[] = []

function urlFor(db: string): string {
  const u = new URL(TARGET_URL!)
  u.pathname = `/${db}`
  return u.toString()
}

async function database(name: string, sql: string): Promise<string> {
  const db = `sf_pe_${name}_${stamp}`
  const admin = new pg.Client({ connectionString: TARGET_URL! })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${db}`)
  await admin.end()
  dbs.push(db)
  const c = new pg.Client({ connectionString: urlFor(db) })
  await c.connect()
  await c.query(sql)
  await c.end()
  return urlFor(db)
}

const TABLE = 'CREATE TABLE docs (status varchar(20)); ALTER TABLE docs ENABLE ROW LEVEL SECURITY;'
const WRITTEN = `${TABLE} CREATE POLICY vis ON docs USING (status IN ('draft', 'active'));`
const RENDERED = `${TABLE} CREATE POLICY vis ON docs USING (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying])::text[])));`

afterAll(async () => {
  if (skip) return
  await closePgPools()
  const admin = new pg.Client({ connectionString: TARGET_URL! })
  await admin.connect()
  for (const db of dbs) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db])
    await admin.query(`DROP DATABASE IF EXISTS ${db}`)
  }
  await admin.end()
})

describe('policy equivalence', () => {
  it.skipIf(skip)('re-renders a policy without leaving anything behind', async () => {
    const url = await database('render', WRITTEN)
    const policy = {
      schemaname: 'public', tablename: 'docs', policyname: 'vis', cmd: 'ALL',
      qual: "((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying])::text[]))",
      with_check: null,
    }

    const canonical = await canonicalPolicyExpressions(url, policy)

    expect(canonical?.qual).toBe("((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text]))")
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname = 'sf_canon'`)
    await c.end()
    expect(rows[0].n).toBe(0)
  })

  it.skipIf(skip)('the RLS check calls a restored copy identical', async () => {
    const ctx = {
      source: { dbUrl: await database('src', WRITTEN) },
      target: { dbUrl: await database('tgt', RENDERED) },
      config: { environments: {}, source: 's', target: 't' },
    } as unknown as CheckContext

    const issues = await new RlsCheck().scan(ctx)

    expect(issues.filter(i => i.id.startsWith('rls-modified'))).toEqual([])
  })

  it.skipIf(skip)('and still reports a list that really changed', async () => {
    const ctx = {
      source: { dbUrl: await database('src2', WRITTEN) },
      target: { dbUrl: await database('tgt2', RENDERED.replace("'active'", "'archived'")) },
      config: { environments: {}, source: 's', target: 't' },
    } as unknown as CheckContext

    const issues = await new RlsCheck().scan(ctx)

    expect(issues.map(i => i.id)).toContain('rls-modified-public.docs.vis')
    expect(await dropEquivalentPolicyChanges(issues, ctx, canonicalPolicyExpressions)).toHaveLength(issues.length)
  })
})
