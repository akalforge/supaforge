import { describe, it, expect } from 'vitest'
import {
  parsePgDumpVersion,
  parseServerVersion,
  getInstallInstructions,
  resolvePgRestorePath,
} from '../src/pg-tools'

describe('parsePgDumpVersion', () => {
  it('parses standard pg_dump output', () => {
    expect(parsePgDumpVersion('pg_dump (PostgreSQL) 16.3')).toBe(16)
  })

  it('parses two-digit major version', () => {
    expect(parsePgDumpVersion('pg_dump (PostgreSQL) 17.6')).toBe(17)
  })

  it('parses version without minor', () => {
    expect(parsePgDumpVersion('pg_dump (PostgreSQL) 18')).toBe(18)
  })

  it('returns null for garbage input', () => {
    expect(parsePgDumpVersion('not a version')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parsePgDumpVersion('')).toBeNull()
  })
})

describe('parseServerVersion', () => {
  it('parses Ubuntu-annotated version', () => {
    expect(parseServerVersion('17.6 (Ubuntu 17.6-1.pgdg22.04+1)')).toBe(17)
  })

  it('parses bare version', () => {
    expect(parseServerVersion('16.3')).toBe(16)
  })

  it('parses major-only version', () => {
    expect(parseServerVersion('18')).toBe(18)
  })

  it('returns null for empty string', () => {
    expect(parseServerVersion('')).toBeNull()
  })
})

describe('getInstallInstructions', () => {
  it('includes the major version number', () => {
    const result = getInstallInstructions(17)
    expect(result).toContain('17')
  })

  it('returns non-empty instructions for any platform', () => {
    const result = getInstallInstructions(16)
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('resolvePgRestorePath', () => {
  it('returns pg_restore for default PATH binary', () => {
    expect(resolvePgRestorePath('pg_dump')).toBe('pg_restore')
  })

  it('returns sibling binary for absolute path', () => {
    expect(resolvePgRestorePath('/usr/lib/postgresql/17/bin/pg_dump'))
      .toBe('/usr/lib/postgresql/17/bin/pg_restore')
  })

  it('handles macOS Homebrew path', () => {
    expect(resolvePgRestorePath('/opt/homebrew/opt/postgresql@17/bin/pg_dump'))
      .toBe('/opt/homebrew/opt/postgresql@17/bin/pg_restore')
  })
})
