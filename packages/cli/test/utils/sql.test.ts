import { describe, it, expect } from 'vitest'
import { quoteIdent, quoteName, quoteLiteral, sqlLiteral } from '../../src/utils/sql.js'

// ─── quoteIdent ──────────────────────────────────────────────────────────────

describe('quoteIdent', () => {
  it('quotes a bare identifier', () => {
    expect(quoteIdent('users')).toBe('"users"')
  })

  it('quotes a schema-qualified identifier', () => {
    expect(quoteIdent('public.users')).toBe('"public"."users"')
  })

  it('escapes double quotes in identifier', () => {
    expect(quoteIdent('my"table')).toBe('"my""table"')
  })

  it('escapes double quotes in schema.table', () => {
    expect(quoteIdent('my"schema.my"table')).toBe('"my""schema"."my""table"')
  })

  it('handles three-part names (catalog.schema.table)', () => {
    expect(quoteIdent('db.public.users')).toBe('"db"."public"."users"')
  })

  it('handles empty string', () => {
    expect(quoteIdent('')).toBe('""')
  })

  it('handles identifier with spaces', () => {
    expect(quoteIdent('my table')).toBe('"my table"')
  })

  it('handles reserved words', () => {
    expect(quoteIdent('select')).toBe('"select"')
  })
})

// ─── quoteName ───────────────────────────────────────────────────────────────

describe('quoteName', () => {
  it('quotes a bare name', () => {
    expect(quoteName('users')).toBe('"users"')
  })

  it('does NOT split on dots (treats as single identifier)', () => {
    expect(quoteName('public.users')).toBe('"public.users"')
  })

  it('escapes double quotes', () => {
    expect(quoteName('my"col')).toBe('"my""col"')
  })

  it('handles empty string', () => {
    expect(quoteName('')).toBe('""')
  })
})

// ─── quoteLiteral ────────────────────────────────────────────────────────────

describe('quoteLiteral', () => {
  it('wraps a simple string in single quotes', () => {
    expect(quoteLiteral('hello')).toBe("'hello'")
  })

  it('escapes single quotes by doubling them', () => {
    expect(quoteLiteral("it's")).toBe("'it''s'")
  })

  it('escapes multiple single quotes', () => {
    expect(quoteLiteral("it's ''special''")).toBe("'it''s ''''special'''''")
  })

  it('handles empty string', () => {
    expect(quoteLiteral('')).toBe("''")
  })

  it('does not escape backslashes (Postgres standard conforming)', () => {
    expect(quoteLiteral('path\\to\\file')).toBe("'path\\to\\file'")
  })

  it('handles string with newlines', () => {
    expect(quoteLiteral('line1\nline2')).toBe("'line1\nline2'")
  })
})

// ─── sqlLiteral ──────────────────────────────────────────────────────────────

describe('sqlLiteral', () => {
  it('converts null to NULL', () => {
    expect(sqlLiteral(null)).toBe('NULL')
  })

  it('converts undefined to NULL', () => {
    expect(sqlLiteral(undefined)).toBe('NULL')
  })

  it('converts true to true', () => {
    expect(sqlLiteral(true)).toBe('true')
  })

  it('converts false to false', () => {
    expect(sqlLiteral(false)).toBe('false')
  })

  it('converts integer to string', () => {
    expect(sqlLiteral(42)).toBe('42')
  })

  it('converts float to string', () => {
    expect(sqlLiteral(3.14)).toBe('3.14')
  })

  it('converts zero to string', () => {
    expect(sqlLiteral(0)).toBe('0')
  })

  it('converts negative number to string', () => {
    expect(sqlLiteral(-5)).toBe('-5')
  })

  it('converts string to quoted literal', () => {
    expect(sqlLiteral('hello')).toBe("'hello'")
  })

  it('converts string with single quotes', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'")
  })

  it('converts empty array to ARRAY[]', () => {
    expect(sqlLiteral([])).toBe('ARRAY[]')
  })

  it('converts string array to ARRAY literal', () => {
    expect(sqlLiteral(['a', 'b', 'c'])).toBe("ARRAY['a', 'b', 'c']")
  })

  it('converts mixed array (elements coerced to string)', () => {
    expect(sqlLiteral([1, true, 'x'])).toBe("ARRAY['1', 'true', 'x']")
  })

  it('escapes single quotes inside array elements', () => {
    expect(sqlLiteral(["it's", "that's"])).toBe("ARRAY['it''s', 'that''s']")
  })

  it('converts empty string to quoted empty', () => {
    expect(sqlLiteral('')).toBe("''")
  })
})
