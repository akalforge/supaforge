/**
 * Every name SupaForge writes into SQL itself is quoted with its own quotes
 * doubled.
 *
 * A policy named `say "hi" there` became `DROP POLICY IF EXISTS "say "hi"
 * there"`, a syntax error: a restore holding one rolled back entirely, and a
 * `diff --apply` holding one applied nothing at all. The SQL is read back here
 * with PostgreSQL's own parser, so a name that does not survive the round trip
 * fails the test whatever the text looks like.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseStatements } from '../src/sql-ast.js'
import { diffPolicies } from '../src/checks/rls.js'
import { createPolicySql, dropPolicySql, commentPolicySql, diffSchemaPolicies } from '../src/utils/schema-policies.js'
import { captureSnapshot } from '../src/snapshot.js'
import type { QueryFn } from '../src/db.js'

const NAME = 'say "hi" there'
const TABLE = 'Odd "table"'

/** The policy names, tables and roles each statement in `sql` names, as PostgreSQL reads them. */
function read(sql: string) {
  const statements = parseStatements(sql)
  expect(statements, `does not parse:\n${sql}`).toBeDefined()
  return statements!.map(({ kind, node }) => {
    if (kind === 'CommentStmt') return { kind, name: node.object?.List?.items?.at(-1)?.String?.sval }
    return {
      kind,
      name: node.policy_name,
      table: node.table?.relname,
      roles: (node.roles ?? []).map((r: { RoleSpec: { rolename?: string; roletype: string } }) =>
        r.RoleSpec.rolename ?? r.RoleSpec.roletype),
    }
  })
}

const policy = {
  schemaname: 'public', tablename: TABLE, policyname: NAME, permissive: 'PERMISSIVE',
  roles: ['Admins "A"', 'public'], cmd: 'SELECT', qual: 'true', with_check: null, comment: 'a "quoted" note',
}

describe('policy SQL keeps names intact', () => {
  it('in the shared builders', () => {
    const sql = [createPolicySql('public', policy), dropPolicySql('public', policy), commentPolicySql('public', policy)].join('\n')
    const [create, comment, drop] = read(sql)
    expect(create).toMatchObject({ kind: 'CreatePolicyStmt', name: NAME, table: TABLE, roles: ['Admins "A"', 'ROLESPEC_PUBLIC'] })
    expect(comment).toMatchObject({ kind: 'CommentStmt', name: NAME })
    expect(drop.kind).toBe('DropStmt')
  })

  it('in the RLS check', () => {
    const [issue] = diffPolicies([policy as never], [])
    expect(read(issue.sql!.up)[0]).toMatchObject({ name: NAME, table: TABLE })
    expect(read(issue.sql!.down)[0].kind).toBe('DropStmt')
  })

  it('in the storage and Realtime checks', () => {
    const [issue] = diffSchemaPolicies([{ ...policy, tablename: 'objects' }], [], {
      schema: 'storage', check: 'storage', idPrefix: 'storage-policy', label: 'storage',
    })
    expect(read(issue.sql!.up)[0]).toMatchObject({ name: NAME, table: 'objects' })
  })
})

describe('snapshot files keep names intact', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'supaforge-quoted-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('in rls.sql and storage-policies.sql', async () => {
    const queryFn = (async (_url: string, sql: string) =>
      sql.includes('pg_policies') ? [{ ...policy, schemaname: sql.includes("'storage'") ? 'storage' : 'public' }] : []) as unknown as QueryFn
    const result = await captureSnapshot({
      envName: 'prod',
      env: { dbUrl: 'postgres://example' },
      config: { environments: { prod: { dbUrl: 'postgres://example' } } } as never,
      outputDir: dir,
      queryFn,
      fetchFn: (async () => new Response('[]', { status: 200 })) as never,
    })
    for (const file of ['rls.sql', 'storage-policies.sql']) {
      const statements = read(await readFile(join(result.dir, file), 'utf8'))
      expect(statements.find(s => s.kind === 'CreatePolicyStmt'), file).toMatchObject({ name: NAME, table: TABLE })
    }
  })
})
