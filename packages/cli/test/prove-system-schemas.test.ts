import { describe, it, expect } from 'vitest'
import { prepareClone } from '../src/prove.js'
import type { QueryFn } from '../src/db.js'

/**
 * Preparing a proof clone on a target with a system-schema extension (#94).
 *
 * `--prove` aborted on any target with `pg_cron` — every Supabase project with
 * Cron enabled — because Supabase installs it into `pg_catalog`. The extension
 * query filtered `plpgsql` by *name*, so `pg_cron` came through and the clone
 * preparation ran `CREATE SCHEMA IF NOT EXISTS "pg_catalog"`. PostgreSQL
 * rejects a name beginning with `pg_` before it evaluates `IF NOT EXISTS`:
 *
 *     error: unacceptable schema name "pg_catalog"  (42939)
 */
describe('prepareClone: extensions in system schemas', () => {
  /**
   * A query function that answers the extension query from `installed`,
   * records every statement it is asked to run, and fails on a reserved schema
   * the way PostgreSQL does.
   */
  function harness(installed: Array<{ name: string; schema: string }>) {
    const ran: string[] = []

    const queryFn = (async (_url: string, sql: string) => {
      ran.push(sql)

      if (sql.includes('pg_extension')) {
        // Apply the query's own filter, so the test exercises the predicate
        // rather than trusting it.
        return installed.filter(e =>
          !['pg_catalog', 'information_schema'].includes(e.schema)
          && !e.schema.startsWith('pg_'))
      }

      const reserved = /CREATE SCHEMA IF NOT EXISTS "(pg_[^"]*|information_schema)"/.exec(sql)
      if (reserved) {
        throw new Error(`unacceptable schema name "${reserved[1]}"`)
      }
      return []
    }) as unknown as QueryFn

    return { ran, queryFn }
  }

  const SUPABASE_WITH_CRON = [
    { name: 'plpgsql', schema: 'pg_catalog' },
    { name: 'pg_cron', schema: 'pg_catalog' },
    { name: 'pg_net', schema: 'extensions' },
    { name: 'pgsodium', schema: 'pgsodium' },
    { name: 'pg_graphql', schema: 'graphql' },
  ]

  it('does not try to create a system schema', async () => {
    const { ran, queryFn } = harness(SUPABASE_WITH_CRON)

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    const created = ran.filter(sql => sql.startsWith('CREATE SCHEMA'))
    expect(created.some(sql => sql.includes('pg_catalog'))).toBe(false)
    expect(created.some(sql => sql.includes('information_schema'))).toBe(false)
  })

  it('completes on a target with pg_cron', async () => {
    // The whole of #94: this threw before.
    const { queryFn } = harness(SUPABASE_WITH_CRON)

    await expect(
      prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn),
    ).resolves.toBeUndefined()
  })

  it('still creates the schemas that extensions genuinely need', async () => {
    // `extensions` and `pgsodium` are ordinary schemas a Supabase project has,
    // and a column default calling `extensions.uuid_generate_v4()` cannot be
    // created without them. Skipping by a loose `pg%` match would have taken
    // `pgsodium` with it.
    const { ran, queryFn } = harness(SUPABASE_WITH_CRON)

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    const created = ran.filter(sql => sql.startsWith('CREATE SCHEMA')).join('\n')
    expect(created).toContain('"extensions"')
    expect(created).toContain('"pgsodium"')
    expect(created).toContain('"graphql"')
  })

  it('does not create a schema it is about to drop and replay into', async () => {
    const { ran, queryFn } = harness([{ name: 'ext_in_public', schema: 'public' }])

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    expect(ran.filter(sql => sql.startsWith('CREATE SCHEMA'))).toEqual([])
  })

  it('survives a schema the clone will not accept', async () => {
    // Given the same tolerance as the CREATE EXTENSION below it: the replay
    // fails next with a better error than this one.
    const ran: string[] = []
    const queryFn = (async (_url: string, sql: string) => {
      ran.push(sql)
      if (sql.includes('pg_extension')) return [{ name: 'weird', schema: 'weird' }]
      if (sql.startsWith('CREATE SCHEMA')) throw new Error('permission denied for database')
      return []
    }) as unknown as QueryFn

    await expect(
      prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn),
    ).resolves.toBeUndefined()
  })
})
