import { describe, it, expect, vi } from 'vitest'
import { getTableFingerprint, tablesMatch, filterChangedTables } from '../src/checksum.js'
import type { QueryFn } from '../src/db.js'

function makeQueryFn(rowCount: number, sizeBytes: number): QueryFn {
  return vi.fn(async () => [{ row_count: rowCount, size_bytes: String(sizeBytes) }])
}

describe('getTableFingerprint', () => {
  it('returns row count and size from query result', async () => {
    const queryFn = makeQueryFn(42, 8192)
    const fp = await getTableFingerprint('postgres://source', 'public.users', queryFn)
    expect(fp).toEqual({ table: 'public.users', rowCount: 42, sizeBytes: 8192 })
  })

  it('passes the table name in SQL', async () => {
    const queryFn = vi.fn(async () => [{ row_count: 0, size_bytes: '0' }])
    await getTableFingerprint('postgres://x', 'my_schema.my_table', queryFn)
    expect(queryFn).toHaveBeenCalledOnce()
    const sql = queryFn.mock.calls[0][1]
    expect(sql).toContain('"my_schema"."my_table"')
  })
})

describe('tablesMatch', () => {
  it('returns true when fingerprints match', async () => {
    const queryFn = makeQueryFn(100, 16384)
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(true)
  })

  it('returns false when row counts differ', async () => {
    let calls = 0
    const queryFn: QueryFn = vi.fn(async () => {
      calls++
      return [{ row_count: calls === 1 ? 100 : 99, size_bytes: '8192' }]
    })
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(false)
  })

  it('returns false when sizes differ', async () => {
    let calls = 0
    const queryFn: QueryFn = vi.fn(async () => {
      calls++
      return [{ row_count: 100, size_bytes: calls === 1 ? '8192' : '16384' }]
    })
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(false)
  })
})

describe('filterChangedTables', () => {
  it('separates changed from unchanged tables', async () => {
    let callIdx = 0
    const data = [
      // users: same on both
      { row_count: 10, size_bytes: '1024' },
      { row_count: 10, size_bytes: '1024' },
      // orders: different
      { row_count: 50, size_bytes: '4096' },
      { row_count: 55, size_bytes: '4096' },
      // flags: same
      { row_count: 3, size_bytes: '512' },
      { row_count: 3, size_bytes: '512' },
    ]
    const queryFn: QueryFn = vi.fn(async () => {
      return [data[callIdx++]]
    })

    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt',
      ['users', 'orders', 'flags'],
      queryFn,
    )

    expect(result.changed).toEqual(['orders'])
    expect(result.skipped).toContain('users')
    expect(result.skipped).toContain('flags')
  })

  it('includes tables in changed when fingerprint query fails', async () => {
    const queryFn: QueryFn = vi.fn(async () => {
      throw new Error('relation does not exist')
    })
    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt',
      ['nonexistent'],
      queryFn,
    )
    expect(result.changed).toEqual(['nonexistent'])
    expect(result.skipped).toEqual([])
  })

  it('returns all empty when no tables given', async () => {
    const queryFn = makeQueryFn(0, 0)
    const result = await filterChangedTables('postgres://src', 'postgres://tgt', [], queryFn)
    expect(result.changed).toEqual([])
    expect(result.skipped).toEqual([])
  })
})
