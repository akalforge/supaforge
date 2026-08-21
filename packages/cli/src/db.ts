import pg from 'pg'
import { DB_CONNECT_TIMEOUT_MS } from './constants.js'

export type QueryFn = (dbUrl: string, sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/**
 * Resolve the bound on establishing a connection (ms).
 *
 * SUPAFORGE_CONNECT_TIMEOUT is in seconds, so a network that legitimately
 * needs longer than the default can raise it without a code change. A
 * malformed or non-positive value falls back to the default rather than
 * forwarding something `pg` would treat as "wait forever" — which is the very
 * failure this bound exists to prevent (issue #44).
 */
export function resolveConnectTimeoutMs(): number {
  const raw = process.env.SUPAFORGE_CONNECT_TIMEOUT
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  }
  return DB_CONNECT_TIMEOUT_MS
}

/**
 * Build `pg.Client` config with a connection bound always applied.
 *
 * Every client in the codebase goes through here so none can be constructed
 * without one. `queryTimeoutMs` is opt-in: it belongs on short probes, not on
 * a migration or restore that is legitimately slow.
 */
export function pgClientConfig(dbUrl: string, queryTimeoutMs?: number): pg.ClientConfig {
  const config: pg.ClientConfig = {
    connectionString: dbUrl,
    connectionTimeoutMillis: resolveConnectTimeoutMs(),
  }
  if (queryTimeoutMs !== undefined) {
    config.query_timeout = queryTimeoutMs
  }
  return config
}

export const pgQuery: QueryFn = async (dbUrl, sql, params) => {
  const client = new pg.Client(pgClientConfig(dbUrl))
  await client.connect()
  try {
    const { rows } = await client.query(sql, params)
    return rows
  } finally {
    await client.end()
  }
}
