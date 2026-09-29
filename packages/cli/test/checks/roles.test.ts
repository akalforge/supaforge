import { describe, it, expect } from 'vitest'
import { RolesCheck, diffRoles, diffGrants } from '../../src/checks/roles.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

const makeRole = (overrides: Record<string, unknown> = {}) => ({
  rolname: 'app_readonly',
  rolsuper: false,
  rolinherit: true,
  rolcreaterole: false,
  rolcreatedb: false,
  rolcanlogin: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  rolvaliduntil: null,
  ...overrides,
})

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  grantee: 'app_readonly',
  table_schema: 'public',
  table_name: 'users',
  privilege_type: 'SELECT',
  is_grantable: false,
  ...overrides,
})

describe('RolesCheck', () => {
  it('detects missing role in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        return dbUrl.includes('source') ? [makeRole()] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-missing-app_readonly')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('critical')
    expect(issue!.sql?.up).toContain('CREATE ROLE')
    expect(issue!.sql?.down).toContain('DROP ROLE')
  })

  it('detects extra role in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        return dbUrl.includes('target') ? [makeRole({ rolname: 'extra_role' })] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-extra-extra_role')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
    expect(issue!.sql?.up).toContain('DROP ROLE')
  })

  it('detects modified role attributes', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        if (dbUrl.includes('source')) return [makeRole({ rolcanlogin: true })]
        return [makeRole({ rolcanlogin: false })]
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-modified-app_readonly')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
    expect(issue!.sql?.up).toContain('ALTER ROLE')
    expect(issue!.sourceValue).toBeTruthy()
    expect(issue!.targetValue).toBeTruthy()
  })

  it('returns no issues when roles match', async () => {
    const role = makeRole()
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing grant in target', async () => {
    const role = makeRole()
    const grant = makeGrant()
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      if (sql.includes('role_table_grants')) {
        return dbUrl.includes('source') ? [grant] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const grantIssue = issues.find(i => i.id.startsWith('roles-grant-missing'))
    expect(grantIssue).toBeTruthy()
    expect(grantIssue!.severity).toBe('warning')
    expect(grantIssue!.sql?.up).toContain('GRANT SELECT')
    expect(grantIssue!.sql?.down).toContain('REVOKE SELECT')
  })

  it('detects extra grant in target', async () => {
    const role = makeRole()
    const grant = makeGrant({ privilege_type: 'INSERT' })
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      if (sql.includes('role_table_grants')) {
        return dbUrl.includes('target') ? [grant] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const grantIssue = issues.find(i => i.id.startsWith('roles-grant-extra'))
    expect(grantIssue).toBeTruthy()
    expect(grantIssue!.severity).toBe('info')
    expect(grantIssue!.sql?.up).toContain('REVOKE INSERT')
  })

  it('runs all 4 queries (roles x2, grants x2)', async () => {
    const calls: string[] = []
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      calls.push(sql)
      return []
    }
    const check = new RolesCheck(queryFn)
    await check.scan(mockContext())
    expect(calls).toHaveLength(4)
    const roleQueries  = calls.filter(s => s.includes('pg_roles'))
    const grantQueries = calls.filter(s => s.includes('role_table_grants'))
    expect(roleQueries).toHaveLength(2)
    expect(grantQueries).toHaveLength(2)
  })
})

describe('diffRoles', () => {
  it('generates CREATE ROLE with LOGIN attribute', () => {
    const role = makeRole({ rolcanlogin: true })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain('LOGIN')
    expect(issues[0].sql?.up).toContain('CREATE ROLE "app_readonly"')
  })

  it('generates CREATE ROLE with CREATEDB and connection limit', () => {
    const role = makeRole({ rolcreatedb: true, rolconnlimit: 10 })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain('CREATEDB')
    expect(issues[0].sql?.up).toContain('CONNECTION LIMIT 10')
  })

  it('generates DROP ROLE for extra roles', () => {
    const role = makeRole({ rolname: 'obsolete_role' })
    const issues = diffRoles([], [role])
    expect(issues[0].sql?.up).toContain('DROP ROLE IF EXISTS "obsolete_role"')
    expect(issues[0].sql?.down).toContain('CREATE ROLE "obsolete_role"')
  })

  it('generates ALTER ROLE for modified roles', () => {
    const source = makeRole({ rolbypassrls: true })
    const target = makeRole({ rolbypassrls: false })
    const issues = diffRoles([source], [target])
    expect(issues[0].sql?.up).toContain('BYPASSRLS')
    expect(issues[0].sql?.down).not.toContain('BYPASSRLS')
  })

  it('includes VALID UNTIL when set', () => {
    const role = makeRole({ rolvaliduntil: '2025-12-31 00:00:00+00' })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain("VALID UNTIL '2025-12-31 00:00:00+00'")
  })

  it('returns empty when source and target match', () => {
    const role = makeRole()
    expect(diffRoles([role], [role])).toHaveLength(0)
  })

  it('handles multiple roles — reports only differences', () => {
    const roleA = makeRole({ rolname: 'role_a' })
    const roleB = makeRole({ rolname: 'role_b' })
    const roleC = makeRole({ rolname: 'role_c' })
    const issues = diffRoles([roleA, roleB, roleC], [roleA, roleC])
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('roles-missing-role_b')
  })
})

describe('diffGrants', () => {
  it('generates GRANT SQL for missing grants', () => {
    const grant = makeGrant()
    const issues = diffGrants([grant], [])
    expect(issues[0].sql?.up).toBe('GRANT SELECT ON "public"."users" TO "app_readonly";')
    expect(issues[0].sql?.down).toBe('REVOKE SELECT ON "public"."users" FROM "app_readonly";')
  })

  it('generates REVOKE SQL for extra grants', () => {
    const grant = makeGrant({ privilege_type: 'DELETE' })
    const issues = diffGrants([], [grant])
    expect(issues[0].sql?.up).toBe('REVOKE DELETE ON "public"."users" FROM "app_readonly";')
    expect(issues[0].sql?.down).toBe('GRANT DELETE ON "public"."users" TO "app_readonly";')
    expect(issues[0].severity).toBe('info')
  })

  it('returns empty when grants match', () => {
    const grant = makeGrant()
    expect(diffGrants([grant], [grant])).toHaveLength(0)
  })

  it('handles multiple grants across tables', () => {
    const grants = [
      makeGrant({ privilege_type: 'SELECT' }),
      makeGrant({ table_name: 'posts', privilege_type: 'INSERT' }),
    ]
    const issues = diffGrants(grants, [grants[0]])
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toContain('posts')
    expect(issues[0].sql?.up).toContain('posts')
  })

  it('uses correct severity: warning for missing, info for extra', () => {
    const grant = makeGrant()
    const missingIssues = diffGrants([grant], [])
    const extraIssues   = diffGrants([], [grant])
    expect(missingIssues[0].severity).toBe('warning')
    expect(extraIssues[0].severity).toBe('info')
  })
})

/**
 * Which roles' grants are compared (issue #90).
 *
 * `anon`, `authenticated` and `service_role` were filtered out of the grants
 * query along with the platform's own roles. Those three are what the Data API
 * authenticates as, so `REVOKE ALL ON public.plans FROM anon` — the difference
 * between a table being readable through the anon key and not — reported
 * clean, and the drift score stayed at 100.
 */
describe('RolesCheck: the queries it runs', () => {
  /** Capture both statements the check issues. */
  async function capturedSql(): Promise<{ roles: string; grants: string }> {
    const seen: string[] = []
    const queryFn = (async (_url: string, sql: string) => {
      seen.push(sql)
      return []
    }) as unknown as QueryFn

    await new RolesCheck(queryFn).scan(mockContext())

    return {
      roles: seen.find(s => s.includes('pg_roles')) ?? '',
      grants: seen.find(s => s.includes('role_table_grants')) ?? '',
    }
  }

  it('compares grants held by the Data API roles', async () => {
    const { grants } = await capturedSql()

    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(grants, `${role} must not be excluded from the grants query`)
        .not.toContain(`'${role}'`)
    }
  })

  it('still ignores grants held by platform roles', async () => {
    // A difference in these means the two projects run different Supabase
    // versions, not that anybody changed anything.
    const { grants } = await capturedSql()

    for (const role of ['supabase_admin', 'supabase_auth_admin', 'authenticator', 'pgbouncer']) {
      expect(grants, `${role} should still be excluded`).toContain(`'${role}'`)
    }
    expect(grants).toContain("NOT LIKE 'pg_%'")
  })

  it('still ignores the Data API roles when comparing role attributes', async () => {
    // Nobody usefully diffs whether `anon` can log in — that is Supabase's to
    // set. It is only their table grants that belong to the application.
    const { roles } = await capturedSql()

    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(roles, `${role} should still be excluded from the attributes query`)
        .toContain(`'${role}'`)
    }
  })
})
