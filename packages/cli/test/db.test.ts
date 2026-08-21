import { describe, it, expect, afterEach } from 'vitest'
import { resolveConnectTimeoutMs, pgClientConfig } from '../src/db.js'
import { DB_CONNECT_TIMEOUT_MS } from '../src/constants.js'

describe('resolveConnectTimeoutMs', () => {
  afterEach(() => {
    delete process.env.SUPAFORGE_CONNECT_TIMEOUT
  })

  it('defaults to DB_CONNECT_TIMEOUT_MS when unset', () => {
    expect(resolveConnectTimeoutMs()).toBe(DB_CONNECT_TIMEOUT_MS)
  })

  it('honours SUPAFORGE_CONNECT_TIMEOUT (seconds -> ms)', () => {
    process.env.SUPAFORGE_CONNECT_TIMEOUT = '45'
    expect(resolveConnectTimeoutMs()).toBe(45_000)
  })

  it('falls back rather than forwarding a value pg reads as "wait forever"', () => {
    // 0 is pg's own default and means no bound at all, which is the failure
    // this exists to prevent (issue #44).
    for (const v of ['0', '-1', 'abc', '']) {
      process.env.SUPAFORGE_CONNECT_TIMEOUT = v
      expect(resolveConnectTimeoutMs()).toBe(DB_CONNECT_TIMEOUT_MS)
    }
  })
})

describe('pgClientConfig', () => {
  afterEach(() => {
    delete process.env.SUPAFORGE_CONNECT_TIMEOUT
  })

  it('always carries a connection bound', () => {
    const cfg = pgClientConfig('postgres://u:p@h:5432/d')
    expect(cfg.connectionString).toBe('postgres://u:p@h:5432/d')
    expect(cfg.connectionTimeoutMillis).toBe(DB_CONNECT_TIMEOUT_MS)
  })

  it('omits query_timeout unless asked — long migrations must not inherit it', () => {
    expect(pgClientConfig('postgres://u:p@h:5432/d').query_timeout).toBeUndefined()
  })

  it('sets query_timeout when given one', () => {
    expect(pgClientConfig('postgres://u:p@h:5432/d', 9_000).query_timeout).toBe(9_000)
  })

  it('picks up the env override', () => {
    process.env.SUPAFORGE_CONNECT_TIMEOUT = '30'
    expect(pgClientConfig('postgres://u:p@h:5432/d').connectionTimeoutMillis).toBe(30_000)
  })
})
