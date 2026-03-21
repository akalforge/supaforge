import pg from 'pg'

export type QueryFn = (dbUrl: string, sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export const pgQuery: QueryFn = async (dbUrl, sql, params) => {
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    const { rows } = await client.query(sql, params)
    return rows
  } finally {
    await client.end()
  }
}
