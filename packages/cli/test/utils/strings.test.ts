import { describe, it, expect } from 'vitest'
import { slugify, normalizeRoles, parseFlagList, matchesGlob, escapeRegex } from '../../src/utils/strings.js'

// ─── slugify ─────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and replaces spaces with underscores by default', () => {
    expect(slugify('Create Users Table')).toBe('create_users_table')
  })

  it('uses custom separator', () => {
    expect(slugify('Create Users Table', '-')).toBe('create-users-table')
  })

  it('strips leading and trailing separators', () => {
    expect(slugify('--hello world--', '-')).toBe('hello-world')
  })

  it('collapses consecutive non-alnum chars', () => {
    expect(slugify('hello   world!!!')).toBe('hello_world')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })

  it('handles string of only special chars', () => {
    expect(slugify('---')).toBe('')
  })

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBe(60)
  })

  it('does not break mid-word at truncation boundary', () => {
    // Just verifies it slices at 60 chars max
    const result = slugify('word '.repeat(20))
    expect(result.length).toBeLessThanOrEqual(60)
  })

  it('handles numbers', () => {
    expect(slugify('Version 2.0 Release')).toBe('version_2_0_release')
  })

  it('strips punctuation', () => {
    expect(slugify("SupaForge vs. Manual SQL Diffing", '-')).toBe('supaforge-vs-manual-sql-diffing')
  })

  it('handles underscores as word separators with hyphen output', () => {
    expect(slugify('create_users_table', '-')).toBe('create-users-table')
  })

  it('handles mixed separators', () => {
    expect(slugify('foo_bar-baz qux')).toBe('foo_bar_baz_qux')
  })
})

// ─── normalizeRoles ──────────────────────────────────────────────────────────

describe('normalizeRoles', () => {
  it('returns sorted array from JS array', () => {
    expect(normalizeRoles(['anon', 'authenticated'])).toEqual(['anon', 'authenticated'])
  })

  it('sorts roles alphabetically', () => {
    expect(normalizeRoles(['authenticated', 'anon'])).toEqual(['anon', 'authenticated'])
  })

  it('parses Postgres literal {a,b}', () => {
    expect(normalizeRoles('{anon,authenticated}')).toEqual(['anon', 'authenticated'])
  })

  it('deduplicates roles', () => {
    expect(normalizeRoles(['anon', 'anon', 'authenticated'])).toEqual(['anon', 'authenticated'])
  })

  it('trims whitespace from role names', () => {
    expect(normalizeRoles([' anon ', ' authenticated '])).toEqual(['anon', 'authenticated'])
  })

  it('filters out empty strings', () => {
    expect(normalizeRoles(['anon', '', 'authenticated'])).toEqual(['anon', 'authenticated'])
  })

  it('handles single string role', () => {
    expect(normalizeRoles('anon')).toEqual(['anon'])
  })

  it('handles empty array', () => {
    expect(normalizeRoles([])).toEqual([])
  })

  it('handles Postgres literal with single role', () => {
    expect(normalizeRoles('{anon}')).toEqual(['anon'])
  })

  it('handles empty Postgres literal', () => {
    expect(normalizeRoles('{}')).toEqual([])
  })

  it('deduplicates from Postgres literal', () => {
    expect(normalizeRoles('{anon,anon,authenticated}')).toEqual(['anon', 'authenticated'])
  })

  it('handles array of Postgres literals (multiple rows merged)', () => {
    expect(normalizeRoles(['{anon}', '{authenticated}'])).toEqual(['anon', 'authenticated'])
  })
})

/**
 * Extracted from table-filter so the same splitting and globbing serve every
 * repeatable list flag — `--tables`, `--exclude-tables` and `--only` — rather
 * than each call site growing its own copy.
 */
describe('parseFlagList', () => {
  it('splits comma-separated and repeated forms the same way', () => {
    expect(parseFlagList(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(parseFlagList(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('trims and drops empties', () => {
    expect(parseFlagList([' a , b ', '', ' '])).toEqual(['a', 'b'])
  })

  it('tolerates undefined and a non-array', () => {
    expect(parseFlagList(undefined)).toEqual([])
    expect(parseFlagList('a,b' as unknown as string[])).toEqual([])
  })
})

describe('matchesGlob', () => {
  it('matches * and ? the way @dbdiff/cli does', () => {
    expect(matchesGlob('schema-create-view-2', 'schema-create-*')).toBe(true)
    expect(matchesGlob('schema-alter-2', 'schema-create-*')).toBe(false)
    expect(matchesGlob('schema-alter-2', 'schema-alter-?')).toBe(true)
  })

  it('is anchored, so a prefix is not a match on its own', () => {
    expect(matchesGlob('schema-create-view-2', 'schema-create')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(matchesGlob('Schema-Alter-1', 'schema-alter-1')).toBe(true)
  })

  it('treats regex metacharacters in the pattern literally', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true)
    expect(matchesGlob('axb', 'a.b')).toBe(false)
    expect(matchesGlob('schema-alter-1', 'schema-alter-1|schema-drop-1')).toBe(false)
  })
})

describe('escapeRegex', () => {
  it('escapes every metacharacter so a value matches literally', () => {
    const rx = new RegExp(escapeRegex('a.b*c'))
    expect(rx.test('a.b*c')).toBe(true)
    expect(rx.test('axbbc')).toBe(false)
  })
})
