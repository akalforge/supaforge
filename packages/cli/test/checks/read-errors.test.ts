/**
 * A read that fails is an error, never "nothing there".
 *
 * The webhooks, Realtime, cron, Vault and migration checks caught every error
 * and returned an empty list. With a wrong source password, a dropped
 * connection or a role that couldn't read the table, the source looked empty:
 * the target's webhooks, cron jobs and publications then looked extra, and
 * `diff --apply` dropped them; Vault and migrations reported clean. Only a
 * missing table, schema or function — pg_cron not installed, no Realtime —
 * still means there is nothing to compare.
 */
import { describe, it, expect } from 'vitest'
import type { CheckContext } from '../../src/checks/base.js'
import { CheckSkipped } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'
import { WebhooksCheck } from '../../src/checks/webhooks.js'
import { RealtimeCheck } from '../../src/checks/realtime.js'
import { CronCheck } from '../../src/checks/cron.js'
import { VaultCheck } from '../../src/checks/vault.js'
import { MigrationsCheck } from '../../src/checks/migrations.js'
import { StorageCheck } from '../../src/checks/storage.js'

const ctx = {
  source: { dbUrl: 'postgres://source' },
  target: { dbUrl: 'postgres://target' },
  config: { environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } }, source: 'dev', target: 'prod' },
} as CheckContext

const pgError = (message: string, code: string) => Object.assign(new Error(message), { code })
const AUTH_FAILED = pgError('password authentication failed for user "postgres"', '28P01')
const PERMISSION_DENIED = pgError('permission denied for table hooks', '42501')
const CONNECTION_RESET = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' })

/** The target answers with one row for anything; the source fails with `err`. */
function sourceFails(err: Error): QueryFn {
  return (async (dbUrl: string, sql: string) => {
    if (dbUrl.includes('source')) throw err
    if (/AS present/.test(sql)) return [{ present: true }]
    return [{ name: 'x', table_name: 't', schemaname: 'public', tablename: 't', pubname: 'supabase_realtime', jobname: 'j', version: '1' }]
  }) as unknown as QueryFn
}

describe('a source that cannot be read', () => {
  const checks = {
    webhooks: (q: QueryFn) => new WebhooksCheck(q),
    realtime: (q: QueryFn) => new RealtimeCheck(q),
    cron: (q: QueryFn) => new CronCheck(q),
    vault: (q: QueryFn) => new VaultCheck(q),
  }

  for (const [name, make] of Object.entries(checks)) {
    for (const err of [AUTH_FAILED, PERMISSION_DENIED, CONNECTION_RESET]) {
      it(`fails the ${name} check on ${(err as { code: string }).code}`, async () => {
        const result = make(sourceFails(err)).scan(ctx)
        await expect(result).rejects.toThrow(err.message)
        await expect(make(sourceFails(err)).scan(ctx)).rejects.not.toBeInstanceOf(CheckSkipped)
      })
    }
  }
})

describe('a migration history the target role cannot read', () => {
  it('fails the migrations check instead of reporting clean', async () => {
    const queryFn = (async () => { throw pgError('permission denied for schema supabase_migrations', '42501') }) as unknown as QueryFn
    const check = new MigrationsCheck(queryFn, async () => ['20261001000000_init.sql'])
    await expect(check.scan(ctx)).rejects.toThrow('permission denied')
  })
})

describe('storage, read by a role without privileges on it', () => {
  // information_schema lists only what the role holds a privilege on, so the
  // storage schema looked absent: "not a Supabase project", skipped.
  const queryFn = (async (_url: string, sql: string) => {
    if (sql.includes('information_schema')) return sql.includes('AS present') ? [{ present: false }] : []
    if (sql.includes('AS present')) return [{ present: true }]
    if (sql.includes('pg_attribute')) return [{ column_name: 'id' }, { column_name: 'name' }, { column_name: 'public' }]
    throw pgError('permission denied for table buckets', '42501')
  }) as unknown as QueryFn

  it('reports the permission error rather than skipping', async () => {
    await expect(new StorageCheck(queryFn).scan(ctx)).rejects.toThrow('permission denied for table buckets')
  })
})
