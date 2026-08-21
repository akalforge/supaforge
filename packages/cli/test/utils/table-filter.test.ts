import { describe, it, expect } from 'vitest'
import {
  parseTableList,
  resolveTableFilter,
  isFiltered,
  matchesPattern,
  applyTableFilter,
  describeTableFilter,
} from '../../src/utils/table-filter.js'
import type { SupaForgeConfig } from '../../src/types/config.js'

const config = (checks?: SupaForgeConfig['checks']): SupaForgeConfig => ({
  environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
  source: 'dev',
  target: 'prod',
  ...(checks ? { checks } : {}),
})

describe('parseTableList', () => {
  it('splits comma-separated values', () => {
    expect(parseTableList(['orders,order_items'])).toEqual(['orders', 'order_items'])
  })

  it('accepts the flag repeated instead', () => {
    expect(parseTableList(['orders', 'order_items'])).toEqual(['orders', 'order_items'])
  })

  it('accepts both forms mixed', () => {
    expect(parseTableList(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('trims whitespace and drops empties', () => {
    expect(parseTableList([' orders , , order_items '])).toEqual(['orders', 'order_items'])
  })

  it('returns empty for undefined or a non-array', () => {
    expect(parseTableList(undefined)).toEqual([])
    expect(parseTableList('orders' as never)).toEqual([])
  })
})

describe('resolveTableFilter', () => {
  it('is empty when nothing is configured — the default compares everything', () => {
    expect(resolveTableFilter(config())).toEqual({})
    expect(isFiltered(resolveTableFilter(config()))).toBe(false)
  })

  it('reads the config keys', () => {
    expect(resolveTableFilter(config({ tables: ['orders'], excludeTables: ['*_audit'] })))
      .toEqual({ tables: ['orders'], excludeTables: ['*_audit'] })
  })

  it('lets --tables override a broader config list, not widen it', () => {
    // Asking for one table on the command line must mean one table.
    const filter = resolveTableFilter(config({ tables: ['orders', 'customers'] }), { tables: ['orders'] })
    expect(filter.tables).toEqual(['orders'])
  })

  it('unions exclusions from both sources', () => {
    // An exclusion is a safety rail; both sources excluding more is never the
    // surprising direction.
    const filter = resolveTableFilter(config({ excludeTables: ['*_audit'] }), { excludeTables: ['*_log'] })
    expect(filter.excludeTables).toEqual(['*_audit', '*_log'])
  })

  it('does not duplicate an exclusion named in both places', () => {
    const filter = resolveTableFilter(config({ excludeTables: ['*_audit'] }), { excludeTables: ['*_audit'] })
    expect(filter.excludeTables).toEqual(['*_audit'])
  })

  it('tolerates a malformed config rather than throwing', () => {
    // A bad config compares everything instead of taking the scan down.
    expect(resolveTableFilter({ checks: { tables: 'orders' } } as never)).toEqual({})
    expect(resolveTableFilter(undefined)).toEqual({})
  })
})

describe('matchesPattern', () => {
  it('matches an exact name', () => {
    expect(matchesPattern('orders', 'orders')).toBe(true)
    expect(matchesPattern('orders', 'customers')).toBe(false)
  })

  it('supports * and ?', () => {
    expect(matchesPattern('billing_invoices', 'billing_*')).toBe(true)
    expect(matchesPattern('orders_audit', '*_audit')).toBe(true)
    expect(matchesPattern('t1', 't?')).toBe(true)
    expect(matchesPattern('t12', 't?')).toBe(false)
  })

  it('matches a schema-qualified name against a bare pattern', () => {
    // What a user means when they write `--tables=orders`.
    expect(matchesPattern('public.orders', 'orders')).toBe(true)
    expect(matchesPattern('public.orders', 'public.orders')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesPattern('Orders', 'orders')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    // A table name is not a regex; `.` must not become "any character".
    expect(matchesPattern('ordersX', 'orders.')).toBe(false)
    expect(matchesPattern('orders.', 'orders.')).toBe(true)
    expect(matchesPattern('anything', '.*')).toBe(false)
  })
})

describe('applyTableFilter', () => {
  const names = ['orders', 'order_items', 'billing_invoices', 'billing_audit', 'customers']

  it('returns everything when unfiltered', () => {
    expect(applyTableFilter(names, {})).toEqual(names)
    expect(applyTableFilter(names, undefined)).toEqual(names)
  })

  it('keeps only the named tables', () => {
    expect(applyTableFilter(names, { tables: ['orders', 'order_items'] })).toEqual(['orders', 'order_items'])
  })

  it('drops the excluded tables', () => {
    expect(applyTableFilter(names, { excludeTables: ['*_audit'] }))
      .toEqual(['orders', 'order_items', 'billing_invoices', 'customers'])
  })

  it('applies include first, then exclude — as written left to right', () => {
    expect(applyTableFilter(names, { tables: ['billing_*'], excludeTables: ['*_audit'] }))
      .toEqual(['billing_invoices'])
  })

  it('can legitimately match nothing', () => {
    expect(applyTableFilter(names, { tables: ['nope'] })).toEqual([])
  })
})

describe('describeTableFilter', () => {
  it('is null when unfiltered, so nothing is printed', () => {
    expect(describeTableFilter({})).toBeNull()
    expect(describeTableFilter(undefined)).toBeNull()
  })

  it('names the scope and which layers it reaches', () => {
    // A narrowed run must never look like a full one, and a table is a concept
    // only the schema and data checks have.
    const out = describeTableFilter({ tables: ['orders'], excludeTables: ['*_audit'] })!
    expect(out).toContain('only orders')
    expect(out).toContain('excluding *_audit')
    expect(out).toContain('schema and data checks')
    expect(out).toContain('other layers are unfiltered')
  })
})
